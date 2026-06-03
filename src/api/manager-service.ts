import * as crypto from 'node:crypto';
import type { BotRegistry, RegisteredBot } from './bot-registry.js';
import { ManagerStore, type ManagerStoreOptions, type ManagerTask, type ManagerTaskEvent, type ManagerTaskStatus } from './manager-store.js';
import type { TaskScheduler, ScheduledTask, RecurringTask, ScheduleMetadata } from '../scheduler/task-scheduler.js';
import type { CardState } from '../types.js';
import type { Logger } from '../utils/logger.js';

export interface ManagerScope {
  managerBotName: string;
  managerChatId: string;
}

export interface ManagerWorkerInfo {
  name: string;
  platform: RegisteredBot['platform'];
  description?: string;
  specialties?: string[];
  workingDirectory: string;
  status: 'idle' | 'queued' | 'running';
  busy: boolean;
  runningTaskId?: string;
  queuedTaskCount: number;
  recentTaskId?: string;
}

export interface DispatchTaskInput {
  workerBotName: string;
  prompt: string;
  label?: string;
  sessionKey?: string;
  metadata?: Record<string, unknown>;
  sendCards?: boolean;
  waitTimeoutSeconds?: number;
}

export type SendWorkerPromptResult =
  | { mode: 'attached'; task: ManagerTask; prompt: string }
  | { mode: 'dispatched'; task: ManagerTask };

export interface GetTaskOptions {
  includeEvents?: boolean;
}

export interface ListTasksFilter {
  workerBotName?: string;
  status?: ManagerTaskStatus;
  limit?: number;
}

export interface ManagerTaskDetails extends ManagerTask {
  events?: ManagerTaskEvent[];
}

export interface ScheduleReminderInput {
  prompt: string;
  delaySeconds?: number;
  cronExpr?: string;
  timezone?: string;
  label?: string;
  sendCards?: boolean;
  traceId?: string;
}

export type ManagerReminder =
  | {
      id: string;
      type: 'one-time';
      botName: string;
      chatId: string;
      prompt: string;
      executeAt: number;
      sendCards: boolean;
      label?: string;
      status: ScheduledTask['status'];
      createdAt: number;
      metadata?: ScheduleMetadata;
    }
  | {
      id: string;
      type: 'recurring';
      botName: string;
      chatId: string;
      prompt: string;
      cronExpr: string;
      timezone: string;
      nextExecuteAt: number;
      lastExecutedAt?: number;
      sendCards: boolean;
      label?: string;
      status: RecurringTask['status'];
      createdAt: number;
      metadata?: ScheduleMetadata;
    };

export interface ManagerServiceOptions extends ManagerStoreOptions {
  store?: ManagerStore;
}

interface WorkerQueueEntry {
  promise: Promise<void>;
}

interface ManagerConcurrencyState {
  running: number;
  waiters: Array<() => void>;
}

const DEFAULT_SESSION_KEY = 'default';
const MAX_WAIT_TIMEOUT_SECONDS = 60;

export class ManagerService {
  private readonly store: ManagerStore;
  private readonly logger: Logger;
  private readonly ownsStore: boolean;
  private readonly workerQueues = new Map<string, WorkerQueueEntry>();
  private readonly managerConcurrency = new Map<string, ManagerConcurrencyState>();

  constructor(
    private readonly registry: BotRegistry,
    private readonly scheduler: TaskScheduler,
    logger: Logger,
    options: ManagerServiceOptions = {},
  ) {
    this.logger = logger.child({ module: 'manager-service' });
    this.store = options.store ?? new ManagerStore(logger, { dbPath: options.dbPath });
    this.ownsStore = !options.store;

    const recovered = this.store.markInterruptedTasksFailed('Process recovered before manager task completed');
    if (recovered > 0) {
      this.logger.warn({ recovered }, 'Marked interrupted manager tasks as failed');
    }
  }

  listWorkers(scope: ManagerScope): ManagerWorkerInfo[] {
    const manager = this.requireManager(scope);
    const allowed = this.allowedWorkerNames(manager);
    if (allowed.size === 0) return [];

    return this.registry
      .listRegistered()
      .filter((bot) => bot.name !== manager.name && allowed.has(bot.name))
      .map((bot) => {
        const recent = this.store.listTasks({
          managerBotName: scope.managerBotName,
          managerChatId: scope.managerChatId,
          workerBotName: bot.name,
          limit: 25,
        });
        const running = recent.find((task) => task.status === 'running');
        const queued = recent.filter((task) => task.status === 'queued');
        return {
          name: bot.name,
          platform: bot.platform,
          description: bot.config.description,
          specialties: bot.config.specialties,
          workingDirectory: bot.config.claude.defaultWorkingDirectory,
          status: running ? 'running' : queued.length > 0 ? 'queued' : 'idle',
          busy: !!running || queued.length > 0,
          runningTaskId: running?.id,
          queuedTaskCount: queued.length,
          recentTaskId: recent[0]?.id,
        };
      });
  }

  async dispatchTask(scope: ManagerScope, input: DispatchTaskInput): Promise<ManagerTask> {
    const manager = this.requireManager(scope);
    this.validateManagerConcurrency(manager);
    const worker = this.requireWorker(manager, input.workerBotName);
    if (!input.prompt?.trim()) {
      throw new Error('Prompt is required');
    }

    const workerChatId = buildWorkerChatId(scope, worker.name, input.sessionKey);
    const task = this.store.createTask({
      managerBotName: scope.managerBotName,
      managerChatId: scope.managerChatId,
      workerBotName: worker.name,
      workerChatId,
      label: input.label,
      prompt: input.prompt,
      metadata: {
        ...(input.metadata ?? {}),
        sessionKey: input.sessionKey ?? DEFAULT_SESSION_KEY,
      },
    });
    this.store.appendEvent(task.id, 'queued', { workerChatId });

    this.enqueueWorkerTask(task.id, workerChatId, input.sendCards ?? false);

    const waitSeconds = normalizeWaitTimeoutSeconds(input.waitTimeoutSeconds);
    if (waitSeconds > 0) {
      return this.waitForTask(task.id, waitSeconds);
    }

    return task;
  }

  async sendWorkerPrompt(scope: ManagerScope, input: DispatchTaskInput): Promise<SendWorkerPromptResult> {
    const manager = this.requireManager(scope);
    this.validateManagerConcurrency(manager);
    const worker = this.requireWorker(manager, input.workerBotName);
    if (!input.prompt?.trim()) throw new Error('Prompt is required');

    const workerChatId = buildWorkerChatId(scope, worker.name, input.sessionKey);
    const running = this.findRunningTask(scope, worker.name, workerChatId);
    if (!running) {
      const task = await this.dispatchTask(scope, { ...input, sendCards: input.sendCards ?? false });
      return { mode: 'dispatched', task };
    }

    const attached = worker.bridge.appendPromptToRunningTask(workerChatId, input.prompt);
    if (!attached) {
      throw new Error(`Running worker task is not active in this process: ${running.id}`);
    }
    this.store.appendEvent(running.id, 'prompt_sent', {
      prompt: input.prompt,
      promptLength: input.prompt.length,
      sessionKey: input.sessionKey ?? DEFAULT_SESSION_KEY,
    });
    return { mode: 'attached', task: this.store.getTask(running.id) ?? running, prompt: input.prompt };
  }

  getTask(scope: ManagerScope, taskId: string, options: GetTaskOptions = {}): ManagerTaskDetails | undefined {
    this.requireManager(scope);
    const task = this.store.getTask(taskId);
    if (!task || !isTaskInScope(task, scope)) return undefined;
    if (!options.includeEvents) return task;
    return { ...task, events: this.store.listEvents(task.id) };
  }

  listTasks(scope: ManagerScope, filter: ListTasksFilter = {}): ManagerTask[] {
    this.requireManager(scope);
    return this.store.listTasks({
      managerBotName: scope.managerBotName,
      managerChatId: scope.managerChatId,
      workerBotName: filter.workerBotName,
      status: filter.status,
      limit: filter.limit,
    });
  }

  cancelTask(scope: ManagerScope, taskId: string, reason = 'Cancelled by manager'): boolean {
    this.requireManager(scope);
    const task = this.store.getTask(taskId);
    if (!task || !isTaskInScope(task, scope)) return false;
    if (isTerminalStatus(task.status)) return false;

    this.store.appendEvent(task.id, 'cancel_requested', { reason });

    let stopped = false;
    if (task.status === 'running') {
      const worker = this.registry.get(task.workerBotName);
      stopped = worker?.bridge.stopChatTask(task.workerChatId) ?? false;
    }

    this.store.updateTask(task.id, {
      status: 'cancelled',
      completedAt: Date.now(),
      error: reason,
    });
    this.store.appendEvent(task.id, 'cancelled', { reason, stopped });
    return true;
  }

  scheduleReminder(scope: ManagerScope, input: ScheduleReminderInput): ManagerReminder {
    this.requireManager(scope);
    if (!input.prompt?.trim()) {
      throw new Error('Prompt is required');
    }

    const hasDelay = input.delaySeconds !== undefined;
    const hasCron = input.cronExpr !== undefined && input.cronExpr.trim().length > 0;
    if (hasDelay && (!Number.isFinite(input.delaySeconds) || input.delaySeconds! <= 0)) {
      throw new Error('delaySeconds must be a positive number');
    }
    if (hasDelay === hasCron) {
      throw new Error('Provide exactly one of delaySeconds or cronExpr');
    }

    const metadata: ScheduleMetadata = {
      origin: 'manager-mcp',
      createdByBotName: scope.managerBotName,
      createdByChatId: scope.managerChatId,
      traceId: input.traceId ?? `trace-${crypto.randomUUID()}`,
    };

    if (hasCron) {
      return recurringToReminder(this.scheduler.scheduleRecurring({
        botName: scope.managerBotName,
        chatId: scope.managerChatId,
        prompt: input.prompt,
        cronExpr: input.cronExpr!.trim(),
        timezone: input.timezone,
        sendCards: input.sendCards ?? true,
        label: input.label,
        metadata,
      }));
    }

    return taskToReminder(this.scheduler.scheduleTask({
      botName: scope.managerBotName,
      chatId: scope.managerChatId,
      prompt: input.prompt,
      delaySeconds: input.delaySeconds!,
      sendCards: input.sendCards ?? true,
      label: input.label,
      metadata,
    }));
  }

  listReminders(scope: ManagerScope): ManagerReminder[] {
    this.requireManager(scope);
    const ownedByScope = (metadata?: ScheduleMetadata) => (
      metadata?.origin === 'manager-mcp'
      && metadata.createdByBotName === scope.managerBotName
      && metadata.createdByChatId === scope.managerChatId
    );

    return [
      ...this.scheduler.listTasks()
        .filter((task) => ownedByScope(task.metadata))
        .map(taskToReminder),
      ...this.scheduler.listRecurringTasks()
        .filter((task) => ownedByScope(task.metadata))
        .map(recurringToReminder),
    ];
  }

  cancelReminder(scope: ManagerScope, reminderId: string): boolean {
    const reminder = this.listReminders(scope).find((item) => item.id === reminderId);
    if (!reminder) return false;
    return reminder.type === 'one-time'
      ? this.scheduler.cancelTask(reminderId)
      : this.scheduler.cancelRecurring(reminderId);
  }

  destroy(): void {
    this.workerQueues.clear();
    this.managerConcurrency.clear();
    if (this.ownsStore) {
      this.store.close();
    }
  }

  private requireManager(scope: ManagerScope): RegisteredBot {
    const manager = this.registry.get(scope.managerBotName);
    if (!manager) {
      throw new Error(`Manager bot not found: ${scope.managerBotName}`);
    }
    if (manager.config.manager?.enabled !== true) {
      throw new Error(`Bot is not manager-enabled: ${scope.managerBotName}`);
    }
    return manager;
  }

  private requireWorker(manager: RegisteredBot, workerBotName: string): RegisteredBot {
    const worker = this.registry.get(workerBotName);
    if (!worker) {
      throw new Error(`Worker bot not found: ${workerBotName}`);
    }
    if (worker.name === manager.name) {
      throw new Error('Self-delegation is not allowed');
    }

    const allowed = this.allowedWorkerNames(manager);
    if (!allowed.has(worker.name)) {
      throw new Error(`Worker bot is not allowed for manager ${manager.name}: ${worker.name}`);
    }

    return worker;
  }

  private allowedWorkerNames(manager: RegisteredBot): Set<string> {
    const cfg = manager.config.manager;
    if (cfg?.allowAllLocalWorkers === true) {
      return new Set(
        this.registry
          .listRegistered()
          .filter((bot) => bot.name !== manager.name)
          .map((bot) => bot.name),
      );
    }
    if (cfg?.workers?.length) {
      return new Set(cfg.workers);
    }
    return new Set();
  }

  private managerConcurrencyLimit(managerBotName: string): number | undefined {
    const manager = this.registry.get(managerBotName);
    const value = manager?.config.manager?.maxConcurrentWorkerTasks;
    if (value === undefined) return undefined;
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`manager.maxConcurrentWorkerTasks must be a positive integer for ${managerBotName}`);
    }
    return value;
  }

  private validateManagerConcurrency(manager: RegisteredBot): void {
    this.managerConcurrencyLimit(manager.name);
  }

  private enqueueWorkerTask(taskId: string, workerChatId: string, sendCards: boolean): void {
    const previous = this.workerQueues.get(workerChatId)?.promise ?? Promise.resolve();
    const next = previous
      .catch((err) => {
        this.logger.warn({ err, workerChatId }, 'Previous manager worker task failed before queue continuation');
      })
      .then(() => this.runTaskWithManagerSlot(taskId, sendCards))
      .catch((err) => {
        this.logger.error({ err, taskId, workerChatId }, 'Manager worker task queue runner failed');
      });

    const queued = next.finally(() => {
      if (this.workerQueues.get(workerChatId)?.promise === queued) {
        this.workerQueues.delete(workerChatId);
      }
    });
    this.workerQueues.set(workerChatId, { promise: queued });
  }

  private async runTaskWithManagerSlot(taskId: string, sendCards: boolean): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task || task.status === 'cancelled') return;
    const release = await this.acquireManagerSlot(task);
    try {
      await this.runTask(taskId, sendCards);
    } finally {
      release();
    }
  }

  private async acquireManagerSlot(task: ManagerTask): Promise<() => void> {
    const limit = this.managerConcurrencyLimit(task.managerBotName);
    if (limit === undefined) return () => {};

    const key = managerScopeKey(task);
    const state = this.getConcurrencyState(key);
    if (state.running < limit) {
      state.running++;
      return () => this.releaseManagerSlot(key);
    }

    this.store.appendEvent(task.id, 'concurrency_waiting', { limit, running: state.running });
    await new Promise<void>((resolve) => state.waiters.push(resolve));
    return () => this.releaseManagerSlot(key);
  }

  private releaseManagerSlot(key: string): void {
    const state = this.managerConcurrency.get(key);
    if (!state) return;
    const next = state.waiters.shift();
    if (next) {
      next();
      return;
    }
    state.running = Math.max(0, state.running - 1);
    if (state.running === 0) this.managerConcurrency.delete(key);
  }

  private getConcurrencyState(key: string): ManagerConcurrencyState {
    const existing = this.managerConcurrency.get(key);
    if (existing) return existing;
    const created: ManagerConcurrencyState = { running: 0, waiters: [] };
    this.managerConcurrency.set(key, created);
    return created;
  }

  private findRunningTask(scope: ManagerScope, workerBotName: string, workerChatId: string): ManagerTask | undefined {
    return this.store.listTasks({
      managerBotName: scope.managerBotName,
      managerChatId: scope.managerChatId,
      workerBotName,
      status: 'running',
      limit: 100,
    }).find((task) => task.workerChatId === workerChatId);
  }

  private async runTask(taskId: string, sendCards: boolean): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task || task.status === 'cancelled') return;

    const worker = this.registry.get(task.workerBotName);
    if (!worker) {
      this.failTask(task, `Worker bot not found: ${task.workerBotName}`);
      await this.notifyManager(task.id);
      return;
    }

    const startedAt = Date.now();
    const running = this.store.updateTask(task.id, { status: 'running', startedAt });
    if (!running) return;
    this.store.appendEvent(task.id, 'started', { workerBotName: task.workerBotName, workerChatId: task.workerChatId });

    try {
      const result = await worker.bridge.executeApiTask({
        prompt: task.prompt,
        chatId: task.workerChatId,
        userId: `manager:${task.managerBotName}`,
        sendCards,
        onRawMessage: (message) => {
          this.store.appendEvent(task.id, 'worker_message', { message });
        },
        onUpdate: (state: CardState, messageId: string, final: boolean) => {
          this.store.appendEvent(task.id, 'worker_update', workerUpdatePayload(state, messageId, final));
        },
      });

      if (this.store.getTask(task.id)?.status === 'cancelled') return;

      const completedAt = Date.now();
      const durationMs = result.durationMs ?? completedAt - startedAt;
      if (result.success) {
        this.store.updateTask(task.id, {
          status: 'completed',
          completedAt,
          costUsd: result.costUsd,
          durationMs,
          resultText: result.responseText,
        });
        this.store.appendEvent(task.id, 'completed', { durationMs, costUsd: result.costUsd });
        await this.notifyManager(task.id);
      } else {
        this.store.updateTask(task.id, {
          status: 'failed',
          completedAt,
          costUsd: result.costUsd,
          durationMs,
          resultText: result.responseText,
          error: result.error ?? 'Worker task failed',
        });
        this.store.appendEvent(task.id, 'failed', { durationMs, error: result.error ?? 'Worker task failed' });
        await this.notifyManager(task.id);
      }
    } catch (err: any) {
      if (this.store.getTask(task.id)?.status === 'cancelled') return;
      this.failTask(task, err?.message ?? 'Worker task failed');
      await this.notifyManager(task.id);
    }
  }

  private failTask(task: ManagerTask, error: string): void {
    this.store.updateTask(task.id, {
      status: 'failed',
      completedAt: Date.now(),
      error,
    });
    this.store.appendEvent(task.id, 'failed', { error });
  }

  private async notifyManager(taskId: string): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task || !isTerminalStatus(task.status)) return;

    const manager = this.registry.get(task.managerBotName);
    if (!manager) {
      this.store.appendEvent(task.id, 'manager_notification_failed', { error: `Manager bot not found: ${task.managerBotName}` });
      return;
    }

    try {
      await manager.sender.sendTextNotice(
        task.managerChatId,
        managerNotificationTitle(task),
        managerNotificationBody(task),
        managerNotificationColor(task.status),
      );
      this.store.appendEvent(task.id, 'manager_notified', { status: task.status });
    } catch (err: any) {
      this.store.appendEvent(task.id, 'manager_notification_failed', { error: err?.message ?? 'Manager notification failed' });
      this.logger.warn({ err, taskId }, 'Manager notification failed');
    }
  }

  private async waitForTask(taskId: string, timeoutSeconds: number): Promise<ManagerTask> {
    const expiresAt = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < expiresAt) {
      const task = this.store.getTask(taskId);
      if (!task) throw new Error(`Manager task not found: ${taskId}`);
      if (isTerminalStatus(task.status)) return task;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const task = this.store.getTask(taskId);
    if (!task) throw new Error(`Manager task not found: ${taskId}`);
    return task;
  }
}

export function buildWorkerChatId(scope: ManagerScope, workerBotName: string, sessionKey = DEFAULT_SESSION_KEY): string {
  const digest = crypto
    .createHash('sha256')
    .update(JSON.stringify({
      managerBotName: scope.managerBotName,
      managerChatId: scope.managerChatId,
      workerBotName,
      sessionKey,
    }))
    .digest('hex')
    .slice(0, 32);
  return `manager-worker-${digest}`;
}

function normalizeWaitTimeoutSeconds(waitTimeoutSeconds: number | undefined): number {
  if (waitTimeoutSeconds === undefined || waitTimeoutSeconds <= 0 || !Number.isFinite(waitTimeoutSeconds)) {
    return 0;
  }
  return Math.min(waitTimeoutSeconds, MAX_WAIT_TIMEOUT_SECONDS);
}

function isTaskInScope(task: ManagerTask, scope: ManagerScope): boolean {
  return task.managerBotName === scope.managerBotName && task.managerChatId === scope.managerChatId;
}

function isTerminalStatus(status: ManagerTaskStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled';
}

function managerScopeKey(task: Pick<ManagerTask, 'managerBotName' | 'managerChatId'>): string {
  return `${task.managerBotName}\u0000${task.managerChatId}`;
}

function workerUpdatePayload(state: CardState, messageId: string, final: boolean): Record<string, unknown> {
  return {
    final,
    messageId,
    status: state.status,
    responseText: state.responseText,
    responsePreview: state.responseText?.slice(0, 1000),
    toolCalls: state.toolCalls,
    backgroundEvents: state.backgroundEvents,
    teamState: state.teamState,
    pendingQuestion: state.pendingQuestion,
    errorMessage: state.errorMessage,
    costUsd: state.costUsd,
    durationMs: state.durationMs,
    model: state.model,
    totalTokens: state.totalTokens,
    contextWindow: state.contextWindow,
    sessionCostUsd: state.sessionCostUsd,
  };
}

function managerNotificationTitle(task: ManagerTask): string {
  const label = task.label ? `: ${task.label}` : '';
  return `Worker task ${task.status}${label}`;
}

function managerNotificationBody(task: ManagerTask): string {
  const lines = [
    `Task: ${task.id}`,
    `Trace: ${task.traceId}`,
    `Worker: ${task.workerBotName}`,
    `Status: ${task.status}`,
  ];
  if (task.durationMs !== undefined) lines.push(`Duration: ${task.durationMs} ms`);
  if (task.costUsd !== undefined) lines.push(`Cost: $${task.costUsd}`);
  if (task.error) lines.push(`Error: ${task.error}`);
  if (task.resultText) lines.push('', task.resultText);
  return lines.join('\n');
}

function managerNotificationColor(status: ManagerTaskStatus): string {
  if (status === 'completed') return 'green';
  if (status === 'failed') return 'red';
  return 'orange';
}

function taskToReminder(task: ScheduledTask): ManagerReminder {
  return {
    id: task.id,
    type: 'one-time',
    botName: task.botName,
    chatId: task.chatId,
    prompt: task.prompt,
    executeAt: task.executeAt,
    sendCards: task.sendCards,
    label: task.label,
    status: task.status,
    createdAt: task.createdAt,
    metadata: task.metadata,
  };
}

function recurringToReminder(task: RecurringTask): ManagerReminder {
  return {
    id: task.id,
    type: 'recurring',
    botName: task.botName,
    chatId: task.chatId,
    prompt: task.prompt,
    cronExpr: task.cronExpr,
    timezone: task.timezone,
    nextExecuteAt: task.nextExecuteAt,
    lastExecutedAt: task.lastExecutedAt,
    sendCards: task.sendCards,
    label: task.label,
    status: task.status,
    createdAt: task.createdAt,
    metadata: task.metadata,
  };
}
