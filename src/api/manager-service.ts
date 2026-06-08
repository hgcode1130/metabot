import * as crypto from 'node:crypto';
import type { BotRegistry, RegisteredBot } from './bot-registry.js';
import type { CircuitBreaker } from './circuit-breaker.js';
import {
  ManagerStore,
  type ManagerStoreOptions,
  type ManagerTask,
  type ManagerTaskEvent,
  type ManagerTaskEventPayloadMode,
  type ManagerTaskEventType,
  type ManagerTaskStatus,
} from './manager-store.js';
import type { TaskScheduler, ScheduledTask, RecurringTask, ScheduleMetadata } from '../scheduler/task-scheduler.js';
import type { CardState } from '../types.js';
import type { Logger } from '../utils/logger.js';
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
import { getDefaultTaskExecutionQueue } from '../utils/task-execution-queue.js';
import {
  checkpointSummary,
  ManagerCheckpointWriter,
  type ManagerCheckpointPayload,
} from './manager-checkpoint.js';
import { buildWorkerTaskPrompt, normalizeWorkerTaskTemplate, WORKER_TASK_OUTPUT_CONTRACT_VERSION, type WorkerTaskTemplate } from './manager-worker-template.js';
import {
  buildInstructionContract,
  contractMetadata,
  readInstructionContract,
  type InstructionContract,
} from '../utils/instruction-contract.js';
import {
  buildAcceptanceReport,
  parseWorkerResult,
  workerResultSummary,
  type WorkerArtifact,
  type WorkerResult,
} from './worker-result.js';
import {
  ManagerTraceRecorder,
  managerTracePolicyFromMetadata,
  managerTracePolicyMetadata,
  resolveManagerTracePolicy,
  type ManagerTracePolicy,
} from './manager-trace-policy.js';
import {
  resolveDelegationBudget,
  workflowTasks,
} from './manager-delegation-budget.js';
import {
  buildTaskWorkLog,
  buildWorkflowWorkLog,
  type ManagerTaskWorkLog,
  type ManagerWorkflowWorkLog,
} from './manager-work-log.js';
import { resolveEngineName } from '../engines/index.js';

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
  forbiddenActions?: string[];
  acceptanceCriteria?: string[];
  sideEffectClass?: SideEffectClass;
  idempotencyKey?: string;
  sendCards?: boolean;
  waitTimeoutSeconds?: number;
}

export type SendWorkerPromptResult =
  | { mode: 'attached'; task: ManagerTask; prompt: string }
  | { mode: 'dispatched'; task: ManagerTask };

export interface GetTaskOptions {
  includeEvents?: boolean;
  eventLimit?: number;
  eventType?: ManagerTaskEventType;
  eventPayload?: ManagerTaskEventPayloadMode;
}

export interface ListTasksFilter {
  workerBotName?: string;
  status?: ManagerTaskStatus;
  limit?: number;
}

export interface ListManagerTasksFilter extends ListTasksFilter {
  managerChatId?: string;
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
  workflowId?: string;
  traceId?: string;
  sideEffectClass?: SideEffectClass;
  idempotencyKey?: string;
}

export type CancelTaskOutcomeStatus =
  | 'cancelled'
  | 'cancel_failed_to_stop'
  | 'not_found'
  | 'terminal';

export interface CancelTaskOutcome {
  taskId: string;
  cancelled: boolean;
  status: CancelTaskOutcomeStatus;
  reason: string;
  stopped?: boolean;
  currentStatus?: ManagerTaskStatus;
  workerBotName?: string;
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
      origin?: ScheduleMetadata['origin'];
      createdByBotName?: string;
      createdByChatId?: string;
      workflowId?: string;
      traceId?: string;
      sideEffectClass?: SideEffectClass;
      idempotencyKey?: string;
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
      lastFailureAt?: number;
      lastError?: string;
      needsCompensation?: boolean;
      compensationReason?: string;
      sendCards: boolean;
      label?: string;
      status: RecurringTask['status'];
      createdAt: number;
      metadata?: ScheduleMetadata;
      origin?: ScheduleMetadata['origin'];
      createdByBotName?: string;
      createdByChatId?: string;
      workflowId?: string;
      traceId?: string;
      sideEffectClass?: SideEffectClass;
      idempotencyKey?: string;
    };

export interface ManagerServiceDiagnostics {
  dbPath: string;
  managerPolicies: ManagerWorkerPolicyDiagnostic[];
  recentProblemTasks: ManagerProblemTaskDiagnostic[];
}

export interface ManagerWorkerPolicyDiagnostic {
  managerBotName: string;
  workers: string[];
  allowAllLocalWorkers: boolean;
}

export interface ManagerProblemTaskDiagnostic {
  id: string;
  status: ManagerTaskStatus;
  workerBotName: string;
  updatedAt: number;
  error?: string;
}

export interface ManagerServiceOptions extends ManagerStoreOptions {
  store?: ManagerStore;
  retryDelayMs?: (classification: RetryableTaskError, retryNumber: number) => number;
  circuitBreaker?: CircuitBreaker;
  tracePolicy?: ManagerTracePolicy;
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

interface RecordedWorkerResult {
  metadata: Record<string, unknown>;
  valid: boolean;
  error?: string;
}

const DEFAULT_SESSION_KEY = 'default';
const MAX_WAIT_TIMEOUT_SECONDS = 60;
const NOTIFICATION_PREVIEW_LIMIT = 300;

export class ManagerService {
  private readonly store: ManagerStore;
  private readonly logger: Logger;
  private readonly ownsStore: boolean;
  private readonly workerQueues = new Map<string, WorkerQueueEntry>();
  private readonly managerConcurrency = new Map<string, ManagerConcurrencyState>();
  private readonly retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly retryDelay: (classification: RetryableTaskError, retryNumber: number) => number;
  private readonly circuitBreaker?: CircuitBreaker;
  private readonly tracePolicy: ManagerTracePolicy;

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
    this.circuitBreaker = options.circuitBreaker;
    this.tracePolicy = options.tracePolicy ?? resolveManagerTracePolicy();

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
        const baseFilter = {
          managerBotName: scope.managerBotName,
          managerChatId: scope.managerChatId,
          workerBotName: bot.name,
        };
        const running = this.store.listTasks({ ...baseFilter, status: 'running', limit: 1 })[0];
        const queued = this.store.listTasks({ ...baseFilter, status: 'queued', limit: 500 });
        const recent = this.store.listTasks({ ...baseFilter, limit: 1 })[0];
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
          recentTaskId: recent?.id,
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
    const tracePolicy = this.tracePolicy;
    const delegationBudget = resolveDelegationBudget({
      scope,
      workflowId: input.workflowId,
      taskTemplate,
      metadata: input.metadata,
      existingWorkflowTasks: this.existingWorkflowTasks(scope, input.workflowId),
    });
    const contract = buildInstructionContract({
      prompt: input.prompt,
      metadata: {
        ...(input.metadata ?? {}),
        forbiddenActions: input.forbiddenActions,
        acceptanceCriteria: input.acceptanceCriteria,
      },
      sideEffectClass: input.sideEffectClass,
      idempotencyKey: input.idempotencyKey,
    });
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
        instructionContract: contractMetadata(contract),
        delegationBudget,
        tracePolicy,
        sendCards: input.sendCards ?? false,
        sideEffectClass: contract.sideEffectClass,
        ...(contract.idempotencyKey ? { idempotencyKey: contract.idempotencyKey } : {}),
        ...(input.relatedTaskId ? { relatedTaskId: input.relatedTaskId } : {}),
        ...(input.workflowId ? { workflowId: input.workflowId } : {}),
      },
    });
    this.store.appendEvent(task.id, 'instruction_contract', contractMetadata(contract));
    this.store.appendEvent(task.id, 'delegation_budget', { ...delegationBudget });
    this.store.appendEvent(task.id, 'queued', { workerChatId });
    this.store.appendEvent(task.id, 'trace_policy', { ...managerTracePolicyMetadata(tracePolicy) });

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
    if (!canAttachPromptToRunningTask(worker)) {
      const task = await this.dispatchTask(scope, {
        ...input,
        sendCards: input.sendCards ?? false,
        relatedTaskId: input.relatedTaskId ?? running.id,
        metadata: {
          ...(input.metadata ?? {}),
          followUpMode: 'queued_task',
          followUpFromTaskId: running.id,
        },
      });
      this.store.appendEvent(running.id, 'prompt_queued_as_task', {
        taskId: task.id,
        queuedTaskId: task.id,
        queuedTraceId: task.traceId,
        prompt: input.prompt,
        promptLength: input.prompt.length,
        reason: 'live_prompt_injection_unsupported',
        sessionKey: input.sessionKey ?? DEFAULT_SESSION_KEY,
        relatedTaskId: task.metadata?.relatedTaskId,
        followUpMode: 'queued_task',
      });
      return { mode: 'dispatched', task };
    }

    const followUpContract = buildInstructionContract({
      prompt: input.prompt,
      metadata: {
        ...(input.metadata ?? {}),
        forbiddenActions: input.forbiddenActions,
        acceptanceCriteria: input.acceptanceCriteria,
      },
      sideEffectClass: input.sideEffectClass,
      idempotencyKey: input.idempotencyKey,
    });
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
          instructionContract: followUpContract,
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
      instructionContract: contractMetadata(followUpContract),
      ...(followUpPrompt !== input.prompt ? { outputContractVersion: WORKER_TASK_OUTPUT_CONTRACT_VERSION } : {}),
    });
    return { mode: 'attached', task: this.store.getTask(running.id) ?? running, prompt: followUpPrompt };
  }

  getTask(scope: ManagerScope, taskId: string, options: GetTaskOptions = {}): ManagerTaskDetails | undefined {
    this.requireManager(scope);
    const task = this.store.getTask(taskId);
    if (!task || !isTaskInScope(task, scope)) return undefined;
    if (!options.includeEvents) return task;
    return {
      ...task,
      events: this.store.listEvents(task.id, {
        limit: options.eventLimit,
        type: options.eventType,
        payload: options.eventPayload ?? 'preview',
      }),
    };
  }

  getTaskSummary(scope: ManagerScope, taskId: string): ManagerTaskWorkLog | undefined {
    this.requireManager(scope);
    const task = this.store.getTask(taskId);
    if (!task || !isTaskInScope(task, scope)) return undefined;
    const events = this.store.listEvents(task.id, { limit: 200, payload: 'preview' });
    return buildTaskWorkLog(task, events);
  }

  getWorkflowSummary(scope: ManagerScope, workflowId: string): ManagerWorkflowWorkLog | undefined {
    this.requireManager(scope);
    const tasks = this.existingWorkflowTasks(scope, workflowId);
    if (tasks.length === 0) return undefined;
    const eventsByTaskId = new Map(tasks.map((task) => [
      task.id,
      this.store.listEvents(task.id, { limit: 200, payload: 'preview' }),
    ]));
    return buildWorkflowWorkLog(workflowId, tasks, eventsByTaskId);
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

  listTasksForManager(managerBotName: string, filter: ListManagerTasksFilter = {}): ManagerTask[] {
    this.requireManagerByName(managerBotName);
    return this.store.listTasks({
      managerBotName,
      managerChatId: filter.managerChatId,
      workerBotName: filter.workerBotName,
      status: filter.status,
      limit: filter.limit,
    });
  }

  cancelTask(scope: ManagerScope, taskId: string, reason = 'Cancelled by manager'): boolean {
    return this.cancelTaskDetailed(scope, taskId, reason).cancelled;
  }

  cancelTaskDetailed(scope: ManagerScope, taskId: string, reason = 'Cancelled by manager'): CancelTaskOutcome {
    this.requireManager(scope);
    const task = this.store.getTask(taskId);
    if (!task || !isTaskInScope(task, scope)) {
      return { taskId, cancelled: false, status: 'not_found', reason };
    }
    if (isTerminalStatus(task.status)) {
      return { taskId, cancelled: false, status: 'terminal', reason, currentStatus: task.status };
    }

    this.store.appendEvent(task.id, 'cancel_requested', { reason });

    let stopped = false;
    if (task.status === 'running') {
      const worker = this.registry.get(task.workerBotName);
      stopped = worker?.bridge.stopChatTask(task.workerChatId) ?? false;
      if (!stopped) {
        this.store.appendEvent(task.id, 'cancel_failed_to_stop', { reason, workerBotName: task.workerBotName });
        return {
          taskId,
          cancelled: false,
          status: 'cancel_failed_to_stop',
          reason,
          stopped,
          currentStatus: task.status,
          workerBotName: task.workerBotName,
        };
      }
    }

    this.store.updateTask(task.id, {
      status: 'cancelled',
      completedAt: Date.now(),
      error: reason,
    });
    this.store.appendEvent(task.id, 'cancel_confirmed', { reason, stopped });
    this.store.appendEvent(task.id, 'cancelled', { reason, stopped });
    return { taskId, cancelled: true, status: 'cancelled', reason, stopped, currentStatus: 'cancelled' };
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
      ...(input.workflowId ? { workflowId: input.workflowId } : {}),
      traceId: input.traceId ?? `trace-${crypto.randomUUID()}`,
      ...(input.sideEffectClass ? { sideEffectClass: input.sideEffectClass } : {}),
      ...(input.idempotencyKey ? { idempotencyKey: input.idempotencyKey } : {}),
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

    return [
      ...this.scheduler.listTasks()
        .filter((task) => reminderOwnedByScope(task, scope))
        .map(taskToReminder),
      ...this.scheduler.listRecurringTasks()
        .filter((task) => reminderOwnedByScope(task, scope))
        .map(recurringToReminder),
    ];
  }

  diagnostics(): ManagerServiceDiagnostics {
    const failed = this.store.listTasks({ status: 'failed', limit: 10 });
    const cancelled = this.store.listTasks({ status: 'cancelled', limit: 10 });
    return {
      dbPath: this.store.diagnostics().dbPath,
      managerPolicies: this.registry.listRegistered()
        .filter((bot) => bot.config.manager?.enabled === true)
        .map(managerPolicyDiagnostic),
      recentProblemTasks: [...failed, ...cancelled]
        .sort((a, b) => b.updatedAt - a.updatedAt)
        .slice(0, 10)
        .map(problemTaskDiagnostic),
    };
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
      this.enqueueRecoveredTask(task);
    }
    if (recovered.requeued.length > 0 || recovered.exhausted.length > 0 || recovered.paused.length > 0) {
      this.logger.warn(
        { requeued: recovered.requeued.length, exhausted: recovered.exhausted.length, paused: recovered.paused.length },
        'Recovered interrupted manager tasks',
      );
    }
  }

  private enqueueRecoveredTask(task: ManagerTask): void {
    const delayMs = (task.nextAttemptAt ?? 0) - Date.now();
    if (delayMs > 0) {
      this.scheduleRetryTimer(task.id, task.workerChatId, sendCardsForTask(task), delayMs);
      return;
    }
    this.enqueueWorkerTask(task.id, task.workerChatId, sendCardsForTask(task));
  }

  private requireManager(scope: ManagerScope): RegisteredBot {
    return this.requireManagerByName(scope.managerBotName);
  }

  private requireManagerByName(managerBotName: string): RegisteredBot {
    const manager = this.registry.get(managerBotName);
    if (!manager) {
      throw new Error(`Manager bot not found: ${managerBotName}`);
    }
    if (manager.config.manager?.enabled !== true) {
      throw new Error(`Bot is not manager-enabled: ${managerBotName}`);
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

  private existingWorkflowTasks(scope: ManagerScope, workflowId: string | undefined): ManagerTask[] {
    const tasks = this.store.listTasks({
      managerBotName: scope.managerBotName,
      managerChatId: scope.managerChatId,
      limit: 500,
    });
    return workflowTasks(tasks, scope, workflowId);
  }

  private async runTask(taskId: string, sendCards: boolean): Promise<void> {
    const task = this.store.getTask(taskId);
    if (!task || task.status === 'cancelled') return;

    const worker = this.registry.get(task.workerBotName);
    if (!worker) {
      this.failTask(task, `Worker bot not found: ${task.workerBotName}`, { recordProviderFailure: false });
      await this.notifyManager(task.id);
      return;
    }
    if (!this.isProviderAvailable(task.workerBotName)) {
      this.failTask(task, `Bot "${task.workerBotName}" is temporarily unavailable (circuit open)`, { recordProviderFailure: false });
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
    const traceRecorder = new ManagerTraceRecorder(tracePolicyForTask(task, this.tracePolicy));

    try {
      const result = await worker.bridge.executeApiTask({
        prompt: this.buildExecutionPrompt(task),
        chatId: task.workerChatId,
        userId: `manager:${task.managerBotName}`,
        sendCards,
        executionSource: 'manager-worker',
        backgroundWorker: true,
        onRawMessage: (message) => {
          if (traceRecorder.shouldRecordWorkerMessage()) {
            this.store.appendEvent(task.id, 'worker_message', { message });
          }
          checkpoint.fromRaw(message);
        },
        onUpdate: (state: CardState, messageId: string, final: boolean) => {
          if (traceRecorder.shouldRecordWorkerUpdate(final)) {
            this.store.appendEvent(task.id, 'worker_update', workerUpdatePayload(state, messageId, final));
          }
          checkpoint.fromUpdate(state, final);
        },
      });

      if (this.store.getTask(task.id)?.status === 'cancelled') return;

      const completedAt = Date.now();
      const durationMs = result.durationMs ?? completedAt - startedAt;
      if (result.success) {
        this.circuitBreaker?.recordSuccess(task.workerBotName);
        const workerResult = this.recordWorkerResult(task, result.responseText);
        if (!workerResult.valid) {
          const error = `Invalid worker result: ${workerResult.error}`;
          checkpoint.final({ status: 'error', responseText: result.responseText, costUsd: result.costUsd, durationMs }, error);
          this.store.updateTask(task.id, {
            status: 'failed',
            completedAt,
            costUsd: result.costUsd,
            durationMs,
            resultText: result.responseText,
            error,
            metadata: workerResult.metadata,
          });
          this.store.appendEvent(task.id, 'failed', { durationMs, error, ...taskErrorMetadata(error) });
          await this.notifyManager(task.id);
          return;
        }
        checkpoint.final({ status: 'complete', responseText: result.responseText, costUsd: result.costUsd, durationMs });
        this.store.updateTask(task.id, {
          status: 'completed',
          completedAt,
          costUsd: result.costUsd,
          durationMs,
          resultText: result.responseText,
          metadata: workerResult.metadata,
        });
        this.store.appendEvent(task.id, 'completed', { durationMs, costUsd: result.costUsd });
        await this.notifyManager(task.id);
      } else {
        const error = result.error ?? 'Worker task failed';
        checkpoint.final({ status: 'error', responseText: result.responseText, costUsd: result.costUsd, durationMs }, error);
        if (this.scheduleRetryIfNeeded({ task, error })) return;
        this.recordProviderFailure(task.workerBotName, error);
        this.store.updateTask(task.id, {
          status: 'failed',
          completedAt,
          costUsd: result.costUsd,
          durationMs,
          resultText: result.responseText,
          error,
        });
        this.store.appendEvent(task.id, 'failed', { durationMs, error, ...taskErrorMetadata(error) });
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
      instructionContract: instructionContractForTask(task),
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
    const checkpoint = this.store.listEvents(taskId, { type: 'checkpoint', limit: 1, payload: 'full' }).at(-1);
    return checkpointSummary(checkpoint?.payload);
  }

  private appendCheckpoint(taskId: string, payload: ManagerCheckpointPayload): void {
    const task = this.store.getTask(taskId);
    this.store.appendEvent(taskId, 'checkpoint', payload as unknown as Record<string, unknown>);
    this.store.updateTask(taskId, {
      lastCheckpointAt: Date.now(),
      ...(task ? { metadata: mergeTaskMetadata(task.metadata, { lastCheckpointPreview: checkpointSummary(payload) }) } : {}),
    });
  }

  private isProviderAvailable(botName: string): boolean {
    return this.circuitBreaker?.isAvailable(botName) ?? true;
  }

  private recordProviderFailure(botName: string, error: unknown): void {
    if (!this.circuitBreaker) return;
    if (shouldOpenProviderCircuit(error)) {
      const metadata = taskErrorMetadata(error);
      this.circuitBreaker.open(botName, metadata.errorReason ?? 'auth/configuration error');
      return;
    }
    this.circuitBreaker.recordFailure(botName);
  }

  private scheduleRetryIfNeeded(input: RetrySchedulingInput): boolean {
    const task = this.store.getTask(input.task.id) ?? input.task;
    const classification = classifyRetryableTaskError(input.error);
    if (!classification.retryable) return false;
    const safety = retrySafetyDecision(classification, task.metadata);
    if (!safety.allowed) {
      this.store.appendEvent(task.id, 'retry_paused', {
        code: classification.code,
        kind: classification.kind,
        reason: safety.reason,
        sideEffectClass: safety.sideEffectClass,
      });
      return false;
    }
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
      ...taskErrorMetadata(reason),
    });
  }

  private scheduleRetry(task: ManagerTask, classification: RetryableTaskError): void {
    const retryNumber = task.attemptCount + 1;
    const delayMs = this.retryDelay(classification, retryNumber);
    const nextAttemptAt = Date.now() + delayMs;
    const metadata = { ...(task.metadata ?? {}), retryResume: true };
    const safety = retrySafetyDecision(classification, task.metadata);
    this.store.updateTask(task.id, {
      status: 'queued',
      attemptCount: retryNumber,
      nextAttemptAt,
      lastRetryReason: classification.reason,
      metadata,
    });
    this.store.appendEvent(task.id, 'retry_scheduled', {
      kind: classification.kind,
      code: classification.code,
      reason: classification.reason,
      retryNumber,
      delayMs,
      nextAttemptAt,
      providerStatus: classification.status,
      sideEffectClass: safety.sideEffectClass,
      idempotencyKey: safety.idempotencyKey,
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

  private failTask(
    task: ManagerTask,
    error: string,
    options: { recordProviderFailure?: boolean } = {},
  ): void {
    if (options.recordProviderFailure !== false) this.recordProviderFailure(task.workerBotName, error);
    this.store.updateTask(task.id, {
      status: 'failed',
      completedAt: Date.now(),
      error,
    });
    this.store.appendEvent(task.id, 'failed', { error, ...taskErrorMetadata(error) });
  }

  private recordWorkerResult(task: ManagerTask, responseText: string): RecordedWorkerResult {
    const contract = instructionContractForTask(task);
    const parsed = parseWorkerResult(responseText);
    const report = buildAcceptanceReport(contract.acceptanceCriteria, parsed);
    if (!parsed.ok) {
      this.store.appendEvent(task.id, 'worker_result_invalid', { error: parsed.error });
      this.store.appendEvent(task.id, 'acceptance_report', report);
      return {
        valid: false,
        error: parsed.error,
        metadata: mergeTaskMetadata(task.metadata, {
          workerResultError: parsed.error,
          acceptanceReport: report,
        }),
      };
    }
    return { valid: true, metadata: this.recordStructuredWorkerResult(task, parsed.result, report) };
  }

  private recordStructuredWorkerResult(
    task: ManagerTask,
    result: WorkerResult,
    report: Record<string, unknown>,
  ): Record<string, unknown> {
    const summary = workerResultSummary(result);
    this.store.appendEvent(task.id, 'worker_result', summary);
    for (const artifact of result.artifacts) {
      this.store.appendEvent(task.id, 'artifact_registered', artifactPayload(artifact));
    }
    this.store.appendEvent(task.id, 'acceptance_report', report);
    return mergeTaskMetadata(task.metadata, {
      workerResult: summary,
      artifactRegistry: result.artifacts,
      acceptanceReport: report,
    });
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
  return !!(
    input.taskTemplate
    || input.relatedTaskId
    || input.workflowId
    || input.forbiddenActions?.length
    || input.acceptanceCriteria?.length
  );
}

function canAttachPromptToRunningTask(worker: RegisteredBot): boolean {
  return resolveEngineName(worker.config) === 'claude';
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

function tracePolicyForTask(task: Pick<ManagerTask, 'metadata'>, fallback: ManagerTracePolicy): ManagerTracePolicy {
  return managerTracePolicyFromMetadata(task.metadata?.tracePolicy) ?? fallback;
}

function shouldIncludeResumeInstructions(task: ManagerTask): boolean {
  return task.metadata?.retryResume === true || typeof task.metadata?.resumeRequestedAt === 'number';
}

function managerScopeKey(task: Pick<ManagerTask, 'managerBotName' | 'managerChatId'>): string {
  return `${task.managerBotName}\u0000${task.managerChatId}`;
}

function instructionContractForTask(task: Pick<ManagerTask, 'prompt' | 'metadata'>): InstructionContract {
  return readInstructionContract(task.metadata?.instructionContract)
    ?? buildInstructionContract({ prompt: task.prompt, metadata: task.metadata });
}

function mergeTaskMetadata(
  metadata: Record<string, unknown> | undefined,
  patch: Record<string, unknown>,
): Record<string, unknown> {
  return { ...(metadata ?? {}), ...patch };
}

function artifactPayload(artifact: WorkerArtifact): Record<string, unknown> {
  return {
    ...(artifact.id ? { id: artifact.id } : {}),
    ...(artifact.path ? { path: artifact.path } : {}),
    ...(artifact.url ? { url: artifact.url } : {}),
    ...(artifact.type ? { type: artifact.type } : {}),
    ...(artifact.description ? { description: artifact.description } : {}),
    ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
  };
}

function workerUpdatePayload(state: CardState, messageId: string, final: boolean): Record<string, unknown> {
  return {
    final,
    messageId,
    status: state.status,
    responseText: state.responseText,
    responsePreview: state.responseText?.slice(0, 1000),
    toolCalls: state.toolCalls,
    progressUpdates: state.progressUpdates,
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
    `Attempts: ${task.attemptCount}/${task.maxAttempts}`,
  ];
  const workflowId = metadataString(task.metadata, 'workflowId');
  const relatedTaskId = metadataString(task.metadata, 'relatedTaskId');
  const sideEffectClass = metadataString(task.metadata, 'sideEffectClass');
  const checkpoint = metadataString(task.metadata, 'lastCheckpointPreview');
  if (task.metadata?.workerResultError) lines.push('Substatus: result_invalid');
  if (workflowId) lines.push(`Workflow: ${workflowId}`);
  if (relatedTaskId) lines.push(`Related task: ${relatedTaskId}`);
  if (sideEffectClass) lines.push(`Side effects: ${sideEffectClass}`);
  if (checkpoint) lines.push(`Last checkpoint: ${truncateNotice(checkpoint)}`);
  const acceptance = acceptanceStatusLine(task.metadata);
  if (acceptance) lines.push(acceptance);
  if (task.durationMs !== undefined) lines.push(`Duration: ${task.durationMs} ms`);
  if (task.costUsd !== undefined) lines.push(`Cost: $${task.costUsd}`);
  if (task.error) lines.push(`Error: ${task.error}`);
  const workerSummary = workerResultNotificationLines(task.metadata);
  if (workerSummary.length > 0) {
    lines.push('', ...workerSummary);
  } else if (task.resultText) {
    lines.push('', task.resultText);
  }
  return lines.join('\n');
}

function metadataString(metadata: Record<string, unknown> | undefined, key: string): string | undefined {
  const value = metadata?.[key];
  return typeof value === 'string' && value ? value : undefined;
}

function acceptanceStatusLine(metadata: Record<string, unknown> | undefined): string | undefined {
  const report = metadata?.acceptanceReport;
  if (!report || typeof report !== 'object') return undefined;
  const status = (report as Record<string, unknown>).status;
  return typeof status === 'string' && status ? `Acceptance: ${status}` : undefined;
}

function truncateNotice(value: string): string {
  return value.length <= NOTIFICATION_PREVIEW_LIMIT ? value : `${value.slice(0, NOTIFICATION_PREVIEW_LIMIT)}...`;
}

function workerResultNotificationLines(metadata: Record<string, unknown> | undefined): string[] {
  const result = metadata?.workerResult;
  if (!result || typeof result !== 'object') return [];
  const obj = result as Record<string, unknown>;
  const lines = [`Summary: ${String(obj.summary ?? '')}`];
  const artifacts = Array.isArray(obj.artifacts) ? obj.artifacts : [];
  const verification = Array.isArray(obj.verification) ? obj.verification : [];
  if (verification.length > 0) lines.push(`Verification: ${verification.length} item(s)`);
  if (artifacts.length > 0) lines.push(`Artifacts: ${artifacts.length} registered`);
  return lines;
}

function managerNotificationColor(status: ManagerTaskStatus): string {
  if (status === 'completed') return 'green';
  if (status === 'failed') return 'red';
  return 'orange';
}

function reminderOwnedByScope(
  reminder: (ScheduledTask | RecurringTask) & ScheduleMetadata,
  scope: ManagerScope,
): boolean {
  const trace = reminderTraceFields(reminder);
  return trace.origin === 'manager-mcp'
    && trace.createdByBotName === scope.managerBotName
    && trace.createdByChatId === scope.managerChatId;
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
    ...reminderTraceFields(task),
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
    lastFailureAt: task.lastFailureAt,
    lastError: task.lastError,
    needsCompensation: task.needsCompensation,
    compensationReason: task.compensationReason,
    sendCards: task.sendCards,
    label: task.label,
    status: task.status,
    createdAt: task.createdAt,
    metadata: task.metadata,
    ...reminderTraceFields(task),
  };
}

function reminderTraceFields(reminder: (ScheduledTask | RecurringTask) & ScheduleMetadata): ScheduleMetadata {
  return {
    origin: reminder.origin ?? reminder.metadata?.origin,
    createdByBotName: reminder.createdByBotName ?? reminder.metadata?.createdByBotName,
    createdByChatId: reminder.createdByChatId ?? reminder.metadata?.createdByChatId,
    workflowId: reminder.workflowId ?? reminder.metadata?.workflowId,
    traceId: reminder.traceId ?? reminder.metadata?.traceId,
    sideEffectClass: reminder.sideEffectClass ?? reminder.metadata?.sideEffectClass,
    idempotencyKey: reminder.idempotencyKey ?? reminder.metadata?.idempotencyKey,
  };
}

function managerPolicyDiagnostic(bot: RegisteredBot): ManagerWorkerPolicyDiagnostic {
  return {
    managerBotName: bot.name,
    workers: bot.config.manager?.workers ?? [],
    allowAllLocalWorkers: bot.config.manager?.allowAllLocalWorkers === true,
  };
}

function problemTaskDiagnostic(task: ManagerTask): ManagerProblemTaskDiagnostic {
  return {
    id: task.id,
    status: task.status,
    workerBotName: task.workerBotName,
    updatedAt: task.updatedAt,
    error: task.error,
  };
}
