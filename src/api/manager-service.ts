import * as crypto from 'node:crypto';
import type { BotRegistry, RegisteredBot } from './bot-registry.js';
import { ManagerStore, type ManagerStoreOptions, type ManagerTask, type ManagerTaskEvent, type ManagerTaskStatus } from './manager-store.js';
import type { TaskScheduler, ScheduledTask, RecurringTask, ScheduleMetadata } from '../scheduler/task-scheduler.js';
import type { CardState } from '../types.js';
import type { Logger } from '../utils/logger.js';
import {
  classifyRetryableTaskError,
  maxRetriesFor,
  retryDelayMs,
  type RetryableTaskError,
} from '../utils/retry-policy.js';
import { getDefaultTaskExecutionQueue } from '../utils/task-execution-queue.js';
import {
  checkpointSummary,
  ManagerCheckpointWriter,
  type ManagerCheckpointPayload,
} from './manager-checkpoint.js';
import { buildWorkerTaskPrompt, normalizeWorkerTaskTemplate, WORKER_TASK_OUTPUT_CONTRACT_VERSION, type WorkerTaskTemplate } from './manager-worker-template.js';

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
  taskTemplate?: WorkerTaskTemplate;
  relatedTaskId?: string;
  workflowId?: string;
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
  retryDelayMs?: (classification: RetryableTaskError, retryNumber: number) => number;
}

interface WorkerQueueEntry {
  promise: Promise<void>;
}

interface ManagerConcurrencyState {
  running: number;
  waiters: Array<() => void>;
}

interface RetrySchedulingInput {
  task: ManagerTask;
  error: unknown;
}

const DEFAULT_SESSION_KEY = 'default';
const MAX_WAIT_TIMEOUT_SECONDS = 60;

export class ManagerService {
  private readonly store: ManagerStore;
  private readonly logger: Logger;
  private readonly ownsStore: boolean;
  private readonly workerQueues = new Map<string, WorkerQueueEntry>();
  private readonly managerConcurrency = new Map<string, ManagerConcurrencyState>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryDelay: (classification: RetryableTaskError, retryNumber: number) => number;

  constructor(
    private readonly registry: BotRegistry,
    private readonly scheduler: TaskScheduler,
    logger: Logger,
    options: ManagerServiceOptions = {},
  ) {
    this.logger = logger.child({ module: 'manager-service' });
    this.store = options.store ?? new ManagerStore(logger, { dbPath: options.dbPath });
    this.ownsStore = !options.store;
    this.retryDelay = options.retryDelayMs ?? ((classification, retryNumber) => retryDelayMs(classification, retryNumber));

    this.recoverInterruptedTasks();
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
    const taskTemplate = normalizeWorkerTaskTemplate(input.taskTemplate);
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
        taskTemplate,
        outputContractVersion: WORKER_TASK_OUTPUT_CONTRACT_VERSION,
        sendCards: input.sendCards ?? false,
        ...(input.relatedTaskId ? { relatedTaskId: input.relatedTaskId } : {}),
        ...(input.workflowId ? { workflowId: input.workflowId } : {}),
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

    const followUpPrompt = shouldWrapFollowUpPrompt(input)
      ? buildWorkerTaskPrompt({
          prompt: input.prompt,
          taskTemplate: input.taskTemplate,
          taskId: running.id,
          traceId: running.traceId,
          managerBotName: running.managerBotName,
          workerBotName: running.workerBotName,
          label: input.label ?? running.label,
          relatedTaskId: input.relatedTaskId,
          workflowId: input.workflowId,
        })
      : input.prompt;

    const attached = worker.bridge.appendPromptToRunningTask(workerChatId, followUpPrompt);
    if (!attached) {
      throw new Error(`Running worker task is not active in this process: ${running.id}`);
    }
    this.store.appendEvent(running.id, 'prompt_sent', {
      prompt: input.prompt,
      promptLength: input.prompt.length,
      deliveredPromptLength: followUpPrompt.length,
      sessionKey: input.sessionKey ?? DEFAULT_SESSION_KEY,
      ...(input.taskTemplate ? { taskTemplate: normalizeWorkerTaskTemplate(input.taskTemplate) } : {}),
      ...(input.relatedTaskId ? { relatedTaskId: input.relatedTaskId } : {}),
      ...(input.workflowId ? { workflowId: input.workflowId } : {}),
      ...(followUpPrompt !== input.prompt ? { outputContractVersion: WORKER_TASK_OUTPUT_CONTRACT_VERSION } : {}),
    });
    return { mode: 'attached', task: this.store.getTask(running.id) ?? running, prompt: followUpPrompt };
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

  resumeTask(scope: ManagerScope, taskId: string): ManagerTask {
    this.requireManager(scope);
    const task = this.store.getTask(taskId);
    if (!task || !isTaskInScope(task, scope)) {
      throw new Error(`Manager task not found: ${taskId}`);
    }
    if (task.status === 'completed' || task.status === 'cancelled' || task.status === 'running') {
      throw new Error(`Manager task cannot be resumed from status: ${task.status}`);
    }
    const metadata = {
      ...(task.metadata ?? {}),
      resumeRequestedAt: Date.now(),
      retryResume: true,
    };
    const updated = this.store.updateTask(task.id, {
      status: 'queued',
      nextAttemptAt: Date.now(),
      lastRetryReason: 'Manual resume requested',
      metadata,
    });
    this.store.appendEvent(task.id, 'resume_queued', { reason: 'Manual resume requested' });
    this.enqueueWorkerTask(task.id, task.workerChatId, sendCardsForTask({ ...task, metadata }));
    return updated ?? task;
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
    for (const timer of this.retryTimers.values()) clearTimeout(timer);
    this.retryTimers.clear();
    if (this.ownsStore) {
      this.store.close();
    }
  }

  private recoverInterruptedTasks(): void {
    const reason = 'Process recovered before manager task completed';
    const recovered = this.store.recoverInterruptedTasks(reason);
    for (const task of recovered.requeued) {
      this.enqueueWorkerTask(task.id, task.workerChatId, sendCardsForTask(task));
    }
    if (recovered.requeued.length > 0 || recovered.exhausted.length > 0) {
      this.logger.warn(
        { requeued: recovered.requeued.length, exhausted: recovered.exhausted.length },
        'Recovered interrupted manager tasks',
      );
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
    if (value !== undefined && (!Number.isInteger(value) || value <= 0)) {
      throw new Error(`manager.maxConcurrentWorkerTasks must be a positive integer for ${managerBotName}`);
    }
    const backgroundLimit = getDefaultTaskExecutionQueue().snapshot().limits.maxBackgroundWorkerTasks;
    return Math.min(value ?? backgroundLimit, backgroundLimit);
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
    const attempt = executionAttemptNumber(task);
    this.store.appendEvent(task.id, 'started', { workerBotName: task.workerBotName, workerChatId: task.workerChatId, attempt });
    if (task.attemptCount > 0) {
      this.store.appendEvent(task.id, 'retry_started', { attempt, reason: task.lastRetryReason });
    }
    if (shouldIncludeResumeInstructions(task)) {
      this.store.appendEvent(task.id, 'resumed', { attempt });
    }

    const checkpoint = new ManagerCheckpointWriter(
      (payload) => this.appendCheckpoint(task.id, payload),
      { attempt, workerChatId: task.workerChatId },
    );

    try {
      const result = await worker.bridge.executeApiTask({
        prompt: this.buildExecutionPrompt(task),
        chatId: task.workerChatId,
        userId: `manager:${task.managerBotName}`,
        sendCards,
        executionSource: 'manager-worker',
        backgroundWorker: true,
        onRawMessage: (message) => {
          this.store.appendEvent(task.id, 'worker_message', { message });
          checkpoint.fromRaw(message);
        },
        onUpdate: (state: CardState, messageId: string, final: boolean) => {
          this.store.appendEvent(task.id, 'worker_update', workerUpdatePayload(state, messageId, final));
          checkpoint.fromUpdate(state, final);
        },
      });

      if (this.store.getTask(task.id)?.status === 'cancelled') return;

      const completedAt = Date.now();
      const durationMs = result.durationMs ?? completedAt - startedAt;
      if (result.success) {
        checkpoint.final({ status: 'complete', responseText: result.responseText, costUsd: result.costUsd, durationMs });
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
        const error = result.error ?? 'Worker task failed';
        checkpoint.final({ status: 'error', responseText: result.responseText, costUsd: result.costUsd, durationMs }, error);
        if (this.scheduleRetryIfNeeded({ task, error })) return;
        this.store.updateTask(task.id, {
          status: 'failed',
          completedAt,
          costUsd: result.costUsd,
          durationMs,
          resultText: result.responseText,
          error,
        });
        this.store.appendEvent(task.id, 'failed', { durationMs, error });
        await this.notifyManager(task.id);
      }
    } catch (err: any) {
      if (this.store.getTask(task.id)?.status === 'cancelled') return;
      const error = err?.message ?? 'Worker task failed';
      checkpoint.final(undefined, error);
      if (this.scheduleRetryIfNeeded({ task, error })) return;
      this.failTask(task, error);
      await this.notifyManager(task.id);
    }
  }

  private buildExecutionPrompt(task: ManagerTask): string {
    const basePrompt = buildWorkerTaskPrompt({
      prompt: task.prompt,
      taskTemplate: task.metadata?.taskTemplate,
      taskId: task.id,
      traceId: task.traceId,
      managerBotName: task.managerBotName,
      workerBotName: task.workerBotName,
      label: task.label,
      relatedTaskId: task.metadata?.relatedTaskId,
      workflowId: task.metadata?.workflowId,
    });
    if (!shouldIncludeResumeInstructions(task)) return basePrompt;
    return `${basePrompt}\n\n${this.resumeInstructions(task)}`;
  }

  private resumeInstructions(task: ManagerTask): string {
    const checkpoint = this.latestCheckpointSummary(task.id);
    return [
      'Resume instructions:',
      'Continue this delegated task from the latest checkpoint without duplicating completed work.',
      'If an external side effect may already have happened, verify before repeating it.',
      `Latest checkpoint: ${checkpoint}`,
    ].join('\n');
  }

  private latestCheckpointSummary(taskId: string): string {
    const checkpoint = this.store.listEvents(taskId)
      .filter((event) => event.type === 'checkpoint')
      .at(-1);
    return checkpointSummary(checkpoint?.payload);
  }

  private appendCheckpoint(taskId: string, payload: ManagerCheckpointPayload): void {
    this.store.appendEvent(taskId, 'checkpoint', payload as unknown as Record<string, unknown>);
    this.store.updateTask(taskId, { lastCheckpointAt: Date.now() });
  }

  private scheduleRetryIfNeeded(input: RetrySchedulingInput): boolean {
    const task = this.store.getTask(input.task.id) ?? input.task;
    const classification = classifyRetryableTaskError(input.error);
    if (!classification.retryable) return false;
    if (task.attemptCount >= Math.min(task.maxAttempts, maxRetriesFor(classification))) {
      this.markRetryExhausted(task, classification.reason);
      return false;
    }
    this.scheduleRetry(task, classification);
    return true;
  }

  private markRetryExhausted(task: ManagerTask, reason: string): void {
    this.store.appendEvent(task.id, 'retry_exhausted', {
      attemptCount: task.attemptCount,
      maxAttempts: task.maxAttempts,
      reason,
    });
  }

  private scheduleRetry(task: ManagerTask, classification: RetryableTaskError): void {
    const retryNumber = task.attemptCount + 1;
    const delayMs = this.retryDelay(classification, retryNumber);
    const nextAttemptAt = Date.now() + delayMs;
    const metadata = { ...(task.metadata ?? {}), retryResume: true };
    this.store.updateTask(task.id, {
      status: 'queued',
      attemptCount: retryNumber,
      nextAttemptAt,
      lastRetryReason: classification.reason,
      metadata,
    });
    this.store.appendEvent(task.id, 'retry_scheduled', {
      kind: classification.kind,
      reason: classification.reason,
      retryNumber,
      delayMs,
      nextAttemptAt,
    });
    this.scheduleRetryTimer(task.id, task.workerChatId, sendCardsForTask({ ...task, metadata }), delayMs);
  }

  private scheduleRetryTimer(taskId: string, workerChatId: string, sendCards: boolean, delayMs: number): void {
    const existing = this.retryTimers.get(taskId);
    if (existing) clearTimeout(existing);
    const timer = setTimeout(() => {
      this.retryTimers.delete(taskId);
      this.enqueueWorkerTask(taskId, workerChatId, sendCards);
    }, delayMs);
    this.retryTimers.set(taskId, timer);
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

function shouldWrapFollowUpPrompt(input: DispatchTaskInput): boolean {
  return !!(input.taskTemplate || input.relatedTaskId || input.workflowId);
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

function executionAttemptNumber(task: ManagerTask): number {
  return task.attemptCount + 1;
}

function sendCardsForTask(task: Pick<ManagerTask, 'metadata'>): boolean {
  return task.metadata?.sendCards === true;
}

function shouldIncludeResumeInstructions(task: ManagerTask): boolean {
  return task.metadata?.retryResume === true || typeof task.metadata?.resumeRequestedAt === 'number';
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
