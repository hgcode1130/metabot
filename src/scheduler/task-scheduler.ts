import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Logger } from '../utils/logger.js';
import type { BotRegistry, RegisteredBot } from '../api/bot-registry.js';
import type { CircuitBreaker } from '../api/circuit-breaker.js';
import type { WebSocketHandle } from '../web/ws-server.js';
import type { CardState } from '../types.js';
import { isValidCron, nextCronOccurrence, getDefaultTimezone } from './cron-utils.js';
import {
  classifyRetryableTaskError,
  maxRetriesFor,
  retryDelayMs,
  retrySafetyDecision,
  shouldOpenProviderCircuit,
  taskErrorMetadata,
  type SideEffectClass,
  type RetryableTaskError,
} from '../utils/retry-policy.js';

export interface ScheduleMetadata {
  origin?: 'api' | 'manager-mcp' | 'cli';
  createdByBotName?: string;
  createdByChatId?: string;
  workflowId?: string;
  traceId?: string;
  sideEffectClass?: SideEffectClass;
  idempotencyKey?: string;
}

// --- One-time task types (unchanged) ---

export interface ScheduledTask extends ScheduleMetadata {
  id: string;
  botName: string;
  chatId: string;
  prompt: string;
  executeAt: number;       // Unix ms
  sendCards: boolean;
  label?: string;
  status: 'pending' | 'executing' | 'completed' | 'failed' | 'cancelled';
  createdAt: number;
  retryCount: number;
  attemptCount?: number;
  maxAttempts?: number;
  nextAttemptAt?: number;
  lastRetryReason?: string;
  lastError?: string;
  errorCode?: string;
  errorKind?: string;
  retryable?: boolean;
  providerStatus?: number;
  needsCompensation?: boolean;
  parentRecurringId?: string;  // set if spawned by a recurring task
  metadata?: ScheduleMetadata;
}

export interface ScheduleInput {
  botName: string;
  chatId: string;
  prompt: string;
  delaySeconds: number;
  sendCards?: boolean;
  label?: string;
  metadata?: ScheduleMetadata;
}

export interface ScheduleUpdateInput {
  prompt?: string;
  delaySeconds?: number;
  label?: string;
  sendCards?: boolean;
}

// --- Recurring task types ---

export interface RecurringTask extends ScheduleMetadata {
  id: string;
  botName: string;
  chatId: string;
  prompt: string;
  cronExpr: string;           // 5-field cron: "minute hour dom month dow"
  timezone: string;           // IANA timezone, e.g. "Asia/Shanghai"
  sendCards: boolean;
  label?: string;
  status: 'active' | 'paused' | 'cancelled';
  createdAt: number;          // Unix ms
  nextExecuteAt: number;      // Unix ms — precomputed next fire time
  lastExecutedAt?: number;    // Unix ms
  lastFailureAt?: number;     // Unix ms
  lastError?: string;
  needsCompensation?: boolean;
  compensationReason?: string;
  currentChildId?: string;    // ID of the currently pending/executing child task
  metadata?: ScheduleMetadata;
}

export interface RecurringScheduleInput {
  botName: string;
  chatId: string;
  prompt: string;
  cronExpr: string;
  timezone?: string;
  sendCards?: boolean;
  label?: string;
  metadata?: ScheduleMetadata;
}

export interface RecurringUpdateInput {
  prompt?: string;
  cronExpr?: string;
  timezone?: string;
  label?: string;
  sendCards?: boolean;
}

// --- Persistence format ---

interface PersistedData {
  tasks: ScheduledTask[];
  recurringTasks: RecurringTask[];
}

// --- Constants ---

const DEFAULT_MAX_ATTEMPTS = 5;
const STALE_THRESHOLD_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_SETTIMEOUT_MS = 2_147_483_647; // 2^31 - 1 (~24.8 days)
const CHILD_TASK_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
const PERSIST_DIR = path.join(os.homedir(), '.metabot');
const PERSIST_FILE = path.join(PERSIST_DIR, 'scheduled-tasks.json');

/**
 * Manages scheduled tasks (one-time and recurring) with persistence and timers.
 * Tasks fire via setTimeout and call bridge.executeApiTask().
 */
export class TaskScheduler {
  private tasks = new Map<string, ScheduledTask>();
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private recurringTasks = new Map<string, RecurringTask>();
  private recurringTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private wsHandle?: WebSocketHandle;

  constructor(
    private registry: BotRegistry,
    private logger: Logger,
    private circuitBreaker?: CircuitBreaker,
  ) {
    this.loadFromDisk();
  }

  /** Set WebSocket handle for streaming task updates to connected clients. */
  setWebSocketHandle(handle: WebSocketHandle): void {
    this.wsHandle = handle;
  }

  // ===== One-time task methods (unchanged) =====

  scheduleTask(input: ScheduleInput): ScheduledTask {
    const now = Date.now();
    const task: ScheduledTask = {
      id: crypto.randomUUID(),
      botName: input.botName,
      chatId: input.chatId,
      prompt: input.prompt,
      executeAt: now + input.delaySeconds * 1000,
      sendCards: input.sendCards ?? true,
      label: input.label,
      status: 'pending',
      createdAt: now,
      retryCount: 0,
      attemptCount: 0,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      metadata: input.metadata,
      ...scheduleTraceFields({ metadata: input.metadata }),
    };

    this.tasks.set(task.id, task);
    this.setTimer(task);
    this.saveToDisk();

    this.logger.info({ taskId: task.id, botName: task.botName, chatId: task.chatId, delaySeconds: input.delaySeconds, label: task.label }, 'Scheduled task created');
    return task;
  }

  updateTask(id: string, input: ScheduleUpdateInput): ScheduledTask | null {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'pending') return null;

    if (input.prompt !== undefined) task.prompt = input.prompt;
    if (input.label !== undefined) task.label = input.label;
    if (input.sendCards !== undefined) task.sendCards = input.sendCards;

    if (input.delaySeconds !== undefined) {
      task.executeAt = Date.now() + input.delaySeconds * 1000;
      // Reset timer
      const timer = this.timers.get(id);
      if (timer) clearTimeout(timer);
      this.setTimer(task);
    }

    this.saveToDisk();
    this.logger.info({ taskId: id, updates: input }, 'Scheduled task updated');
    return task;
  }

  cancelTask(id: string): boolean {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'pending') return false;

    task.status = 'cancelled';
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
    this.saveToDisk();

    this.logger.info({ taskId: id }, 'Scheduled task cancelled');
    return true;
  }

  listTasks(): ScheduledTask[] {
    return Array.from(this.tasks.values()).filter((t) => t.status === 'pending');
  }

  taskCount(): number {
    return this.listTasks().length;
  }

  // ===== Recurring task methods =====

  scheduleRecurring(input: RecurringScheduleInput): RecurringTask {
    if (!isValidCron(input.cronExpr)) {
      throw new Error(`Invalid cron expression: ${input.cronExpr}`);
    }

    const tz = input.timezone || getDefaultTimezone();
    const now = Date.now();
    const nextMs = nextCronOccurrence(input.cronExpr, tz);

    const recurring: RecurringTask = {
      id: crypto.randomUUID(),
      botName: input.botName,
      chatId: input.chatId,
      prompt: input.prompt,
      cronExpr: input.cronExpr,
      timezone: tz,
      sendCards: input.sendCards ?? true,
      label: input.label,
      status: 'active',
      createdAt: now,
      nextExecuteAt: nextMs,
      metadata: input.metadata,
      ...scheduleTraceFields({ metadata: input.metadata }),
    };

    this.recurringTasks.set(recurring.id, recurring);
    this.setRecurringTimer(recurring);
    this.saveToDisk();

    this.logger.info(
      { taskId: recurring.id, botName: recurring.botName, chatId: recurring.chatId, cronExpr: recurring.cronExpr, timezone: tz, nextExecuteAt: new Date(nextMs).toISOString(), label: recurring.label },
      'Recurring task created',
    );
    return recurring;
  }

  updateRecurring(id: string, input: RecurringUpdateInput): RecurringTask | null {
    const recurring = this.recurringTasks.get(id);
    if (!recurring || recurring.status === 'cancelled') return null;

    if (input.prompt !== undefined) recurring.prompt = input.prompt;
    if (input.label !== undefined) recurring.label = input.label;
    if (input.sendCards !== undefined) recurring.sendCards = input.sendCards;

    let recomputeNext = false;
    if (input.cronExpr !== undefined) {
      if (!isValidCron(input.cronExpr)) {
        throw new Error(`Invalid cron expression: ${input.cronExpr}`);
      }
      recurring.cronExpr = input.cronExpr;
      recomputeNext = true;
    }
    if (input.timezone !== undefined) {
      recurring.timezone = input.timezone;
      recomputeNext = true;
    }

    if (recomputeNext && recurring.status === 'active') {
      const timer = this.recurringTimers.get(id);
      if (timer) clearTimeout(timer);
      recurring.nextExecuteAt = nextCronOccurrence(recurring.cronExpr, recurring.timezone);
      this.setRecurringTimer(recurring);
    }

    this.saveToDisk();
    this.logger.info({ taskId: id, updates: input }, 'Recurring task updated');
    return recurring;
  }

  pauseRecurring(id: string): boolean {
    const recurring = this.recurringTasks.get(id);
    if (!recurring || recurring.status !== 'active') return false;

    recurring.status = 'paused';
    const timer = this.recurringTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.recurringTimers.delete(id);
    }
    this.saveToDisk();

    this.logger.info({ taskId: id }, 'Recurring task paused');
    return true;
  }

  resumeRecurring(id: string): boolean {
    const recurring = this.recurringTasks.get(id);
    if (!recurring || recurring.status !== 'paused') return false;

    recurring.status = 'active';
    recurring.nextExecuteAt = nextCronOccurrence(recurring.cronExpr, recurring.timezone);
    this.setRecurringTimer(recurring);
    this.saveToDisk();

    this.logger.info({ taskId: id, nextExecuteAt: new Date(recurring.nextExecuteAt).toISOString() }, 'Recurring task resumed');
    return true;
  }

  cancelRecurring(id: string): boolean {
    const recurring = this.recurringTasks.get(id);
    if (!recurring || recurring.status === 'cancelled') return false;

    recurring.status = 'cancelled';
    const timer = this.recurringTimers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.recurringTimers.delete(id);
    }

    // Also cancel any pending child task
    if (recurring.currentChildId) {
      this.cancelTask(recurring.currentChildId);
      recurring.currentChildId = undefined;
    }

    this.saveToDisk();
    this.logger.info({ taskId: id }, 'Recurring task cancelled');
    return true;
  }

  listRecurringTasks(): RecurringTask[] {
    return Array.from(this.recurringTasks.values()).filter((t) => t.status !== 'cancelled');
  }

  getRecurringTask(id: string): RecurringTask | undefined {
    return this.recurringTasks.get(id);
  }

  recurringTaskCount(): number {
    return this.listRecurringTasks().length;
  }

  // ===== Lifecycle =====

  destroy(): void {
    for (const timer of this.timers.values()) {
      clearTimeout(timer);
    }
    this.timers.clear();
    for (const timer of this.recurringTimers.values()) {
      clearTimeout(timer);
    }
    this.recurringTimers.clear();
    this.saveToDisk();
  }

  // ===== One-time timer internals =====

  private setTimer(task: ScheduledTask): void {
    const delay = Math.max(0, task.executeAt - Date.now());
    const timer = setTimeout(() => this.fireTask(task.id), delay);
    this.timers.set(task.id, timer);
  }

  private async fireTask(id: string): Promise<void> {
    const task = this.tasks.get(id);
    if (!task || task.status !== 'pending') return;

    this.timers.delete(id);

    const bot = this.registry.get(task.botName);
    if (!bot) {
      this.logger.error({ taskId: id, botName: task.botName }, 'Scheduled task: bot not found');
      task.status = 'failed';
      this.markTaskError(task, `Bot not found: ${task.botName}`);
      this.saveToDisk();
      this.completeRecurringChild(task);
      return;
    }

    if (!this.isProviderAvailable(task.botName)) {
      await this.failWithoutExecution(task, bot, `Bot "${task.botName}" is temporarily unavailable (circuit open)`);
      return;
    }

    // Execute the task
    task.status = 'executing';
    this.saveToDisk();
    this.logger.info({ taskId: id, botName: task.botName, chatId: task.chatId }, 'Firing scheduled task');

    // Generate a messageId for WebSocket streaming
    const messageId = `sched_${task.id}`;

    const retryQueued = await this.executeScheduledTask(task, bot, messageId);
    if (retryQueued) return;

    this.saveToDisk();
    this.completeRecurringChild(task);
  }

  private async executeScheduledTask(
    task: ScheduledTask,
    bot: RegisteredBot,
    messageId: string,
  ): Promise<boolean> {
    try {
      const result = await bot.bridge.executeApiTask({
        prompt: task.prompt,
        chatId: task.chatId,
        userId: 'scheduler',
        sendCards: task.sendCards,
        executionSource: 'scheduler',
        onUpdate: (state: CardState, _bridgeMessageId: string, final: boolean) => {
          // Stream updates to any WebSocket client subscribed to this chatId
          if (this.wsHandle) {
            const msg = final
              ? { type: 'complete' as const, chatId: task.chatId, messageId, state, botName: task.botName }
              : { type: 'state' as const, chatId: task.chatId, messageId, state, botName: task.botName };
            this.wsHandle.subscriptions.broadcast(task.chatId, msg);
          }
        },
      });

      task.status = result.success ? 'completed' : 'failed';
      if (!result.success) {
        if (this.scheduleRetryIfNeeded(task, result.error ?? 'Scheduled task failed')) return true;
        this.logger.warn({ taskId: task.id, error: result.error }, 'Scheduled task completed with error');
        this.markTaskError(task, result.error ?? 'Scheduled task failed');
        await this.notifyTaskFailure(bot, task);
      }
    } catch (err: any) {
      if (this.scheduleRetryIfNeeded(task, err)) return true;
      this.logger.error({ err, taskId: task.id }, 'Scheduled task execution error');
      task.status = 'failed';
      this.markTaskError(task, err?.message ?? 'Scheduled task execution error');
      await this.notifyTaskFailure(bot, task);
    }
    return false;
  }

  private scheduleRetryIfNeeded(task: ScheduledTask, error: unknown): boolean {
    const classification = classifyRetryableTaskError(error);
    if (!classification.retryable) return false;
    const safety = retrySafetyDecision(classification, task.metadata);
    if (!safety.allowed) {
      task.lastRetryReason = safety.reason;
      this.markTaskError(task, classification.reason);
      this.logger.warn(
        { taskId: task.id, errorCode: classification.code, sideEffectClass: safety.sideEffectClass },
        'Scheduled task retry paused by side-effect safety policy',
      );
      return false;
    }
    const maxAttempts = task.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
    const retryNumber = (task.attemptCount ?? task.retryCount ?? 0) + 1;
    if (retryNumber > Math.min(maxAttempts, maxRetriesFor(classification))) return false;
    this.scheduleRetry(task, classification, retryNumber);
    return true;
  }

  private scheduleRetry(task: ScheduledTask, classification: RetryableTaskError, retryNumber: number): void {
    const delayMs = retryDelayMs(classification, retryNumber);
    task.status = 'pending';
    task.retryCount = retryNumber;
    task.attemptCount = retryNumber;
    task.nextAttemptAt = Date.now() + delayMs;
    task.executeAt = task.nextAttemptAt;
    task.lastRetryReason = classification.reason;
    task.lastError = classification.reason;
    task.errorCode = classification.code;
    task.errorKind = classification.kind;
    task.retryable = true;
    task.providerStatus = classification.status;
    const timer = setTimeout(() => this.fireTask(task.id), delayMs);
    this.timers.set(task.id, timer);
    this.saveToDisk();
    this.logger.info(
      { taskId: task.id, retryNumber, delayMs, reason: classification.reason },
      'Scheduled task retry queued',
    );
  }

  private isProviderAvailable(botName: string): boolean {
    return this.circuitBreaker?.isAvailable(botName) ?? true;
  }

  private async failWithoutExecution(task: ScheduledTask, bot: RegisteredBot, error: string): Promise<void> {
    task.status = 'failed';
    this.markTaskError(task, error);
    this.pauseRecurringForHealth(task, error);
    await this.notifyTaskFailure(bot, task);
    this.saveToDisk();
    this.completeRecurringChild(task);
  }

  private markTaskError(task: ScheduledTask, error: unknown): void {
    const message = errorText(error);
    const metadata = taskErrorMetadata(error);
    task.lastError = message;
    task.errorCode = metadata.errorCode;
    task.errorKind = metadata.errorKind;
    task.retryable = metadata.retryable;
    task.providerStatus = metadata.providerStatus;
    task.needsCompensation = !!task.parentRecurringId;
    if (shouldOpenProviderCircuit(error)) {
      this.circuitBreaker?.open(task.botName, metadata.errorReason ?? message);
      this.pauseRecurringForHealth(task, message);
    }
  }

  private pauseRecurringForHealth(task: ScheduledTask, reason: string): void {
    if (!task.parentRecurringId) return;
    const recurring = this.recurringTasks.get(task.parentRecurringId);
    if (!recurring || recurring.status !== 'active') return;
    recurring.status = 'paused';
    recurring.needsCompensation = true;
    recurring.compensationReason = reason;
    recurring.lastFailureAt = Date.now();
    recurring.lastError = reason;
    this.logger.warn({ recurringId: recurring.id, taskId: task.id, reason }, 'Recurring task paused by provider health gate');
  }

  private async notifyTaskFailure(bot: RegisteredBot, task: ScheduledTask): Promise<void> {
    if (!task.sendCards) return;
    const label = task.label ? `${task.label} (${task.id})` : task.id;
    const lines = [
      `Scheduled task failed: ${label}`,
      `Error: ${task.lastError ?? 'Unknown error'}`,
      task.errorCode ? `Error code: ${task.errorCode}` : undefined,
      task.needsCompensation ? 'Compensation required: yes' : undefined,
    ].filter((line): line is string => !!line);
    try {
      await bot.sender.sendTextNotice(task.chatId, 'Scheduled task failed', lines.join('\n'), 'red');
    } catch (err) {
      this.logger.error({ err, taskId: task.id }, 'Failed to send scheduled task failure notice');
    }
  }

  private completeRecurringChild(task: ScheduledTask): void {
    if (!task.parentRecurringId) return;
    if (task.status !== 'completed' && task.status !== 'failed' && task.status !== 'cancelled') return;
    const recurring = this.recurringTasks.get(task.parentRecurringId);
    if (!recurring || recurring.currentChildId !== task.id) return;
    recurring.lastExecutedAt = Date.now();
    recurring.currentChildId = undefined;
    this.updateRecurringCompensationState(recurring, task);
    if (recurring.status !== 'active') return;
    recurring.nextExecuteAt = nextCronOccurrence(recurring.cronExpr, recurring.timezone);
    this.setRecurringTimer(recurring);
    this.logger.info(
      { recurringId: recurring.id, nextExecuteAt: new Date(recurring.nextExecuteAt).toISOString() },
      'Recurring task: next occurrence scheduled',
    );
  }

  private updateRecurringCompensationState(recurring: RecurringTask, task: ScheduledTask): void {
    if (task.status === 'completed') {
      recurring.needsCompensation = false;
      recurring.compensationReason = undefined;
      return;
    }
    if (task.status !== 'failed') return;
    recurring.lastFailureAt = Date.now();
    recurring.lastError = task.lastError;
    recurring.needsCompensation = true;
    recurring.compensationReason = task.lastError;
    this.logger.warn(
      { recurringId: recurring.id, childId: task.id, errorCode: task.errorCode },
      'Recurring task instance failed; compensation required',
    );
  }

  // ===== Recurring timer internals =====

  private setRecurringTimer(recurring: RecurringTask): void {
    const delay = Math.max(0, recurring.nextExecuteAt - Date.now());

    // setTimeout has a max delay of ~24.8 days (2^31 - 1 ms).
    // For longer delays, set a re-check timer that recomputes when it fires.
    if (delay > MAX_SETTIMEOUT_MS) {
      const timer = setTimeout(() => {
        this.recurringTimers.delete(recurring.id);
        // Recompute — if still in the future, set another timer; if now, fire.
        this.setRecurringTimer(recurring);
      }, MAX_SETTIMEOUT_MS);
      this.recurringTimers.set(recurring.id, timer);
      return;
    }

    const timer = setTimeout(() => this.fireRecurringInstance(recurring.id), delay);
    this.recurringTimers.set(recurring.id, timer);
  }

  private async fireRecurringInstance(recurringId: string): Promise<void> {
    const recurring = this.recurringTasks.get(recurringId);
    if (!recurring || recurring.status !== 'active') return;

    this.recurringTimers.delete(recurringId);

    // Create a one-time child task for this occurrence
    const child: ScheduledTask = {
      id: crypto.randomUUID(),
      botName: recurring.botName,
      chatId: recurring.chatId,
      prompt: recurring.prompt,
      executeAt: Date.now(),
      sendCards: recurring.sendCards,
      label: recurring.label ? `${recurring.label} (recurring)` : undefined,
      status: 'pending',
      createdAt: Date.now(),
      retryCount: 0,
      attemptCount: 0,
      maxAttempts: DEFAULT_MAX_ATTEMPTS,
      parentRecurringId: recurring.id,
      metadata: recurring.metadata,
    };

    this.tasks.set(child.id, child);
    recurring.currentChildId = child.id;
    this.saveToDisk();

    this.logger.info(
      { recurringId, childId: child.id, botName: recurring.botName, chatId: recurring.chatId },
      'Firing recurring task instance',
    );

    // Execute via existing fireTask (handles retries, bot lookup, etc.)
    await this.fireTask(child.id);

    this.saveToDisk();
  }

  // ===== Persistence =====

  private saveToDisk(): void {
    try {
      const data: PersistedData = {
        tasks: this.persistableTasks(),
        recurringTasks: Array.from(this.recurringTasks.values()),
      };
      writeFileAtomic(PERSIST_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      this.logger.error({ err }, 'Failed to save scheduled tasks to disk');
      throw err;
    }
  }

  private loadFromDisk(): void {
    if (!fs.existsSync(PERSIST_FILE)) return;
    try {
      const { taskList, recurringList } = readPersistedData(PERSIST_FILE);
      const now = Date.now();
      this.restoreOneTimeTasks(taskList, now);
      this.restoreRecurringTasks(taskList, recurringList);
      this.logRestoredTasks();
    } catch (err) {
      this.logger.error({ err, path: PERSIST_FILE }, 'Failed to load scheduled tasks from disk');
      throw err;
    }
  }

  private persistableTasks(): ScheduledTask[] {
    return Array.from(this.tasks.values()).filter((task) => {
      if (!task.parentRecurringId || (task.status !== 'completed' && task.status !== 'failed')) return true;
      return Date.now() - task.createdAt < CHILD_TASK_RETENTION_MS;
    });
  }

  private restoreOneTimeTasks(taskList: ScheduledTask[], now: number): void {
    for (const task of taskList) {
      if (task.status === 'executing') {
        task.status = 'pending';
        task.executeAt = now;
        task.lastRetryReason = 'Process recovered while scheduled task was executing';
      }
      if (task.status !== 'pending') continue;
      if (task.executeAt < now - STALE_THRESHOLD_MS) {
        this.logger.info({ taskId: task.id }, 'Skipping stale scheduled task (>24h overdue)');
        continue;
      }
      task.attemptCount = task.attemptCount ?? task.retryCount ?? 0;
      task.maxAttempts = task.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
      if (task.nextAttemptAt && task.nextAttemptAt > now) task.executeAt = task.nextAttemptAt;
      this.tasks.set(task.id, task);
      this.setTimer(task);
    }
  }

  private restoreRecurringTasks(taskList: ScheduledTask[], recurringList: RecurringTask[]): void {
    for (const recurring of recurringList) {
      if (recurring.status === 'cancelled') continue;
      this.recurringTasks.set(recurring.id, recurring);
      if (recurring.status !== 'active') continue;
      if (this.restoreRecurringChild(taskList, recurring)) continue;
      recurring.currentChildId = undefined;
      recurring.nextExecuteAt = nextCronOccurrence(recurring.cronExpr, recurring.timezone);
      this.setRecurringTimer(recurring);
    }
  }

  private restoreRecurringChild(taskList: ScheduledTask[], recurring: RecurringTask): boolean {
    if (!recurring.currentChildId) return false;
    const child = taskList.find((task) => task.id === recurring.currentChildId);
    if (!child || child.status !== 'pending') return false;
    this.tasks.set(child.id, child);
    if (!this.timers.has(child.id)) this.setTimer(child);
    return true;
  }

  private logRestoredTasks(): void {
    const restoredTasks = this.listTasks().length;
    const restoredRecurring = this.listRecurringTasks().length;
    if (restoredTasks === 0 && restoredRecurring === 0) return;
    this.logger.info({ tasks: restoredTasks, recurring: restoredRecurring }, 'Restored scheduled tasks from disk');
  }
}

function readPersistedData(filePath: string): { taskList: ScheduledTask[]; recurringList: RecurringTask[] } {
  const raw = fs.readFileSync(filePath, 'utf-8');
  const parsed = JSON.parse(raw) as PersistedData | ScheduledTask[];
  if (Array.isArray(parsed)) return { taskList: parsed.map(normalizeScheduledTask), recurringList: [] };
  if (!parsed || typeof parsed !== 'object') {
    throw new Error(`Invalid scheduled tasks persistence data in ${filePath}`);
  }
  return {
    taskList: (parsed.tasks || []).map(normalizeScheduledTask),
    recurringList: (parsed.recurringTasks || []).map(normalizeRecurringTask),
  };
}

function normalizeScheduledTask(task: ScheduledTask): ScheduledTask {
  return { ...task, ...scheduleTraceFields(task) };
}

function normalizeRecurringTask(task: RecurringTask): RecurringTask {
  return { ...task, ...scheduleTraceFields(task) };
}

function scheduleTraceFields(source: ScheduleMetadata & { metadata?: ScheduleMetadata }): ScheduleMetadata {
  return {
    origin: source.origin ?? source.metadata?.origin,
    createdByBotName: source.createdByBotName ?? source.metadata?.createdByBotName,
    createdByChatId: source.createdByChatId ?? source.metadata?.createdByChatId,
    workflowId: source.workflowId ?? source.metadata?.workflowId,
    traceId: source.traceId ?? source.metadata?.traceId,
    sideEffectClass: source.sideEffectClass ?? source.metadata?.sideEffectClass,
    idempotencyKey: source.idempotencyKey ?? source.metadata?.idempotencyKey,
  };
}

function writeFileAtomic(filePath: string, content: string): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  let fd: number | undefined;
  try {
    fd = fs.openSync(tmpPath, 'w');
    fs.writeFileSync(fd, content, 'utf-8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(tmpPath, filePath);
    fsyncDirectory(path.dirname(filePath));
  } catch (err) {
    if (fd !== undefined) fs.closeSync(fd);
    removeTempFile(tmpPath);
    throw err;
  }
}

function fsyncDirectory(dirPath: string): void {
  const fd = fs.openSync(dirPath, 'r');
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

function removeTempFile(tmpPath: string): void {
  if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
}

function errorText(error: unknown): string {
  if (typeof error === 'string' && error) return error;
  if (error instanceof Error) return error.message;
  if (error && typeof error === 'object') {
    const message = (error as { message?: unknown }).message;
    if (typeof message === 'string' && message) return message;
  }
  return 'Unknown error';
}
