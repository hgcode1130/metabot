import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Logger } from '../utils/logger.js';
import type { BotRegistry } from '../api/bot-registry.js';
import type { WebSocketHandle } from '../web/ws-server.js';
import type { CardState } from '../types.js';
import { isValidCron, nextCronOccurrence, getDefaultTimezone } from './cron-utils.js';
import {
  classifyRetryableTaskError,
  maxRetriesFor,
  retryDelayMs,
  type RetryableTaskError,
} from '../utils/retry-policy.js';

export interface ScheduleMetadata {
  origin?: 'api' | 'manager-mcp' | 'cli';
  createdByBotName?: string;
  createdByChatId?: string;
  traceId?: string;
}

// --- One-time task types (unchanged) ---

export interface ScheduledTask {
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

export interface RecurringTask {
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
      this.saveToDisk();
      this.completeRecurringChild(task);
      return;
    }

    // Execute the task
    task.status = 'executing';
    this.saveToDisk();
    this.logger.info({ taskId: id, botName: task.botName, chatId: task.chatId }, 'Firing scheduled task');

    // Generate a messageId for WebSocket streaming
    const messageId = `sched_${task.id}`;

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
        if (this.scheduleRetryIfNeeded(task, result.error ?? 'Scheduled task failed')) return;
        this.logger.warn({ taskId: id, error: result.error }, 'Scheduled task completed with error');
        task.lastError = result.error;
      }
    } catch (err: any) {
      if (this.scheduleRetryIfNeeded(task, err)) return;
      this.logger.error({ err, taskId: id }, 'Scheduled task execution error');
      task.status = 'failed';
      task.lastError = err?.message ?? 'Scheduled task execution error';
    }

    this.saveToDisk();
    this.completeRecurringChild(task);
  }

  private scheduleRetryIfNeeded(task: ScheduledTask, error: unknown): boolean {
    const classification = classifyRetryableTaskError(error);
    if (!classification.retryable) return false;
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
    const timer = setTimeout(() => this.fireTask(task.id), delayMs);
    this.timers.set(task.id, timer);
    this.saveToDisk();
    this.logger.info(
      { taskId: task.id, retryNumber, delayMs, reason: classification.reason },
      'Scheduled task retry queued',
    );
  }

  private completeRecurringChild(task: ScheduledTask): void {
    if (!task.parentRecurringId) return;
    if (task.status !== 'completed' && task.status !== 'failed' && task.status !== 'cancelled') return;
    const recurring = this.recurringTasks.get(task.parentRecurringId);
    if (!recurring || recurring.currentChildId !== task.id) return;
    recurring.lastExecutedAt = Date.now();
    recurring.currentChildId = undefined;
    if (recurring.status !== 'active') return;
    recurring.nextExecuteAt = nextCronOccurrence(recurring.cronExpr, recurring.timezone);
    this.setRecurringTimer(recurring);
    this.logger.info(
      { recurringId: recurring.id, nextExecuteAt: new Date(recurring.nextExecuteAt).toISOString() },
      'Recurring task: next occurrence scheduled',
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
      fs.mkdirSync(PERSIST_DIR, { recursive: true });
      // Prune old completed/failed child tasks to prevent unbounded growth
      const tasks = Array.from(this.tasks.values()).filter((t) => {
        if (t.parentRecurringId && (t.status === 'completed' || t.status === 'failed')) {
          const age = Date.now() - t.createdAt;
          return age < 7 * 24 * 60 * 60 * 1000; // keep for 7 days
        }
        return true;
      });
      const data: PersistedData = {
        tasks,
        recurringTasks: Array.from(this.recurringTasks.values()),
      };
      fs.writeFileSync(PERSIST_FILE, JSON.stringify(data, null, 2));
    } catch (err) {
      this.logger.error({ err }, 'Failed to save scheduled tasks to disk');
    }
  }

  private loadFromDisk(): void {
    try {
      if (!fs.existsSync(PERSIST_FILE)) return;

      const raw = fs.readFileSync(PERSIST_FILE, 'utf-8');
      const parsed = JSON.parse(raw);
      const now = Date.now();

      // Backward compatibility: old format is a plain array of ScheduledTask
      let taskList: ScheduledTask[];
      let recurringList: RecurringTask[];
      if (Array.isArray(parsed)) {
        taskList = parsed;
        recurringList = [];
      } else {
        taskList = (parsed as PersistedData).tasks || [];
        recurringList = (parsed as PersistedData).recurringTasks || [];
      }

      // Restore one-time tasks
      for (const task of taskList) {
        if (task.status === 'executing') {
          task.status = 'pending';
          task.executeAt = now;
          task.lastRetryReason = 'Process recovered while scheduled task was executing';
        }
        if (task.status !== 'pending') continue;

        // Skip tasks that are more than 24h overdue (stale)
        if (task.executeAt < now - STALE_THRESHOLD_MS) {
          this.logger.info({ taskId: task.id }, 'Skipping stale scheduled task (>24h overdue)');
          continue;
        }

        task.attemptCount = task.attemptCount ?? task.retryCount ?? 0;
        task.maxAttempts = task.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
        if (task.nextAttemptAt && task.nextAttemptAt > now) {
          task.executeAt = task.nextAttemptAt;
        }
        this.tasks.set(task.id, task);
        this.setTimer(task);
      }

      // Restore recurring tasks
      for (const recurring of recurringList) {
        if (recurring.status === 'cancelled') continue;

        this.recurringTasks.set(recurring.id, recurring);

        if (recurring.status === 'active') {
          // If there was a child task executing when process died, mark it failed
          if (recurring.currentChildId) {
            const child = taskList.find((t) => t.id === recurring.currentChildId);
            if (child && child.status === 'pending') {
              this.tasks.set(child.id, child);
              if (!this.timers.has(child.id)) this.setTimer(child);
              continue;
            }
            recurring.currentChildId = undefined;
          }

          // Recompute next occurrence from now (no catch-up for missed occurrences)
          recurring.nextExecuteAt = nextCronOccurrence(recurring.cronExpr, recurring.timezone);
          this.setRecurringTimer(recurring);
        }
      }

      const restoredTasks = this.listTasks().length;
      const restoredRecurring = this.listRecurringTasks().length;
      if (restoredTasks > 0 || restoredRecurring > 0) {
        this.logger.info(
          { tasks: restoredTasks, recurring: restoredRecurring },
          'Restored scheduled tasks from disk',
        );
      }
    } catch (err) {
      this.logger.error({ err }, 'Failed to load scheduled tasks from disk');
    }
  }
}
