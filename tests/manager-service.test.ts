import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('better-sqlite3', async () => {
  const mod = await import('./__mocks__/better-sqlite3.js');
  return { default: mod.default };
});
import type { BotRegistry, RegisteredBot } from '../src/api/bot-registry.js';
import { ManagerService, buildWorkerChatId, type ManagerScope } from '../src/api/manager-service.js';
import { ManagerStore } from '../src/api/manager-store.js';
import type { TaskScheduler, ScheduledTask, RecurringTask, ScheduleInput, RecurringScheduleInput } from '../src/scheduler/task-scheduler.js';
import type { BotConfigBase } from '../src/config.js';
import type { ApiTaskOptions, ApiTaskResult } from '../src/bridge/message-bridge.js';
import type { Logger } from '../src/utils/logger.js';

function createLogger(): Logger {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
    child: vi.fn(),
  } as unknown as Logger;
  (logger.child as any).mockReturnValue(logger);
  return logger;
}

function createTempDbPath(): { dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-service-test-'));
  return { dir, dbPath: path.join(dir, 'manager.db') };
}

function createConfig(name: string, manager?: BotConfigBase['manager']): BotConfigBase {
  return {
    name,
    ...(manager ? { manager } : {}),
    description: `${name} description`,
    specialties: ['testing'],
    claude: {
      defaultWorkingDirectory: `/tmp/${name}`,
      maxTurns: undefined,
      maxBudgetUsd: undefined,
      model: 'claude-test',
      apiKey: undefined,
      outputsBaseDir: `/tmp/${name}/outputs`,
      downloadsDir: `/tmp/${name}/downloads`,
    },
  };
}

function createBot(
  name: string,
  manager?: BotConfigBase['manager'],
  executeApiTask: any = vi.fn().mockResolvedValue({
    success: true,
    responseText: `done:${name}`,
    costUsd: 0.01,
    durationMs: 10,
  }),
): RegisteredBot {
  return {
    name,
    platform: 'feishu',
    config: createConfig(name, manager),
    bridge: {
      executeApiTask,
      stopChatTask: vi.fn().mockReturnValue(true),
      appendPromptToRunningTask: vi.fn().mockReturnValue(true),
      isBusy: vi.fn().mockReturnValue(false),
    } as any,
    sender: {
      sendTextNotice: vi.fn().mockResolvedValue(undefined),
    } as any,
  };
}

function createRegistry(bots: RegisteredBot[]): BotRegistry {
  const byName = new Map(bots.map((bot) => [bot.name, bot]));
  return {
    get: vi.fn((name: string) => byName.get(name)),
    listRegistered: vi.fn(() => Array.from(byName.values())),
  } as unknown as BotRegistry;
}

function createScheduler(): {
  scheduler: TaskScheduler;
  oneTimeTasks: Map<string, ScheduledTask>;
  recurringTasks: Map<string, RecurringTask>;
} {
  const oneTimeTasks = new Map<string, ScheduledTask>();
  const recurringTasks = new Map<string, RecurringTask>();
  let nextId = 1;

  const scheduler = {
    scheduleTask: vi.fn((input: ScheduleInput): ScheduledTask => {
      const task: ScheduledTask = {
        id: `sched-${nextId++}`,
        botName: input.botName,
        chatId: input.chatId,
        prompt: input.prompt,
        executeAt: Date.now() + input.delaySeconds * 1000,
        sendCards: input.sendCards ?? true,
        label: input.label,
        status: 'pending',
        createdAt: Date.now(),
        retryCount: 0,
        metadata: input.metadata,
      };
      oneTimeTasks.set(task.id, task);
      return task;
    }),
    scheduleRecurring: vi.fn((input: RecurringScheduleInput): RecurringTask => {
      const task: RecurringTask = {
        id: `recur-${nextId++}`,
        botName: input.botName,
        chatId: input.chatId,
        prompt: input.prompt,
        cronExpr: input.cronExpr,
        timezone: input.timezone ?? 'Asia/Shanghai',
        sendCards: input.sendCards ?? true,
        label: input.label,
        status: 'active',
        createdAt: Date.now(),
        nextExecuteAt: Date.now() + 60_000,
        metadata: input.metadata,
      };
      recurringTasks.set(task.id, task);
      return task;
    }),
    listTasks: vi.fn(() => Array.from(oneTimeTasks.values()).filter((task) => task.status === 'pending')),
    listRecurringTasks: vi.fn(() => Array.from(recurringTasks.values()).filter((task) => task.status !== 'cancelled')),
    cancelTask: vi.fn((id: string) => {
      const task = oneTimeTasks.get(id);
      if (!task || task.status !== 'pending') return false;
      task.status = 'cancelled';
      return true;
    }),
    cancelRecurring: vi.fn((id: string) => {
      const task = recurringTasks.get(id);
      if (!task || task.status === 'cancelled') return false;
      task.status = 'cancelled';
      return true;
    }),
  } as unknown as TaskScheduler;

  return { scheduler, oneTimeTasks, recurringTasks };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function waitFor(assertion: () => void, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  let lastError: unknown;
  while (Date.now() - start < timeoutMs) {
    try {
      assertion();
      return;
    } catch (err) {
      lastError = err;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  if (lastError) throw lastError;
}

const scope: ManagerScope = { managerBotName: 'manager', managerChatId: 'chat-a' };

describe('ManagerService', () => {
  let service: ManagerService | undefined;
  let store: ManagerStore | undefined;
  let tmpDir: string | undefined;

  afterEach(() => {
    service?.destroy();
    service = undefined;
    store?.close();
    store = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
    vi.restoreAllMocks();
  });

  function createService(bots: RegisteredBot[]): ManagerService {
    const temp = createTempDbPath();
    tmpDir = temp.dir;
    store = new ManagerStore(createLogger(), { dbPath: temp.dbPath });
    service = new ManagerService(createRegistry(bots), createScheduler().scheduler, createLogger(), { store });
    return service;
  }

  it('lists only explicitly allowed workers and defaults to deny', () => {
    const manager = createBot('manager', { enabled: true, workers: ['worker-a'] });
    const workerA = createBot('worker-a');
    const workerB = createBot('worker-b');
    const managerService = createService([manager, workerA, workerB]);

    expect(managerService.listWorkers(scope).map((worker) => worker.name)).toEqual(['worker-a']);

    service?.destroy();
    store?.close();
    store = undefined;
    const deniedManager = createBot('manager', { enabled: true });
    const deniedService = createService([deniedManager, workerA]);
    expect(deniedService.listWorkers(scope)).toEqual([]);
  });

  it('requires a manager-enabled bot', () => {
    const manager = createBot('manager');
    const worker = createBot('worker-a');
    const managerService = createService([manager, worker]);

    expect(() => managerService.listWorkers(scope)).toThrow('not manager-enabled');
  });

  it('rejects missing, self, and unauthorized workers', async () => {
    const manager = createBot('manager', { enabled: true, workers: ['worker-a'] });
    const workerA = createBot('worker-a');
    const workerB = createBot('worker-b');
    const managerService = createService([manager, workerA, workerB]);

    await expect(managerService.dispatchTask(scope, { workerBotName: 'missing', prompt: 'x' }))
      .rejects.toThrow('Worker bot not found');
    await expect(managerService.dispatchTask(scope, { workerBotName: 'manager', prompt: 'x' }))
      .rejects.toThrow('Self-delegation');
    await expect(managerService.dispatchTask(scope, { workerBotName: 'worker-b', prompt: 'x' }))
      .rejects.toThrow('not allowed');
  });

  it('dispatches a hidden worker task, records lifecycle events, and returns completion when waited', async () => {
    const executeApiTask = vi.fn(async (options: ApiTaskOptions): Promise<ApiTaskResult> => {
      options.onRawMessage?.({ type: 'assistant', message: { content: [{ type: 'text', text: 'raw event' }] } } as any);
      options.onUpdate?.({
        status: 'running',
        userPrompt: options.prompt,
        responseText: 'working',
        toolCalls: [],
      }, 'worker-msg-1', false);
      return { success: true, responseText: 'worker done', costUsd: 0.5, durationMs: 33 };
    });
    const manager = createBot('manager', { enabled: true, workers: ['worker-a'] });
    const worker = createBot('worker-a', undefined, executeApiTask);
    const managerService = createService([manager, worker]);

    const task = await managerService.dispatchTask(scope, {
      workerBotName: 'worker-a',
      prompt: 'Do worker work',
      label: 'Worker label',
      waitTimeoutSeconds: 1,
    });

    expect(task.status).toBe('completed');
    expect(task.resultText).toBe('worker done');
    expect(task.prompt).toBe('Do worker work');
    expect(task.metadata).toMatchObject({
      sessionKey: 'default',
      taskTemplate: 'general',
      outputContractVersion: expect.any(String),
    });
    expect(executeApiTask).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'manager:manager',
      sendCards: false,
    }));
    const callOptions = executeApiTask.mock.calls[0][0];
    expect(callOptions.prompt).toContain('You are executing a delegated MetaBot worker task.');
    expect(callOptions.prompt).toContain('Task ID:');
    expect(callOptions.prompt).toContain('Template: general');
    expect(callOptions.prompt).toContain('Do worker work');
    expect(callOptions.chatId).toMatch(/^manager-worker-[a-f0-9]{32}$/);

    await waitFor(() => expect(managerService.getTask(scope, task.id, { includeEvents: true })?.events?.map((event) => event.type))
      .toContain('manager_notified'));
    const details = managerService.getTask(scope, task.id, { includeEvents: true });
    expect(details?.events?.map((event) => event.type).slice(0, 6)).toEqual([
      'created',
      'queued',
      'started',
      'worker_message',
      'worker_update',
      'completed',
    ]);
    expect(details?.events?.find((event) => event.type === 'worker_message')?.payload)
      .toMatchObject({ message: { type: 'assistant' } });
    const update = details?.events?.find((event) => event.type === 'worker_update');
    expect(update?.payload).toMatchObject({
      responseText: 'working',
      toolCalls: [],
      status: 'running',
    });
    expect(manager.sender.sendTextNotice).toHaveBeenCalledWith(
      'chat-a',
      expect.stringContaining('completed'),
      expect.stringContaining(task.id),
      'green',
    );
  });

  it('applies review templates and workflow metadata to dispatched worker execution', async () => {
    const executeApiTask = vi.fn(async (_options: ApiTaskOptions): Promise<ApiTaskResult> => ({
      success: true,
      responseText: 'review done',
    }));
    const manager = createBot('manager', { enabled: true, workers: ['worker-a'] });
    const worker = createBot('worker-a', undefined, executeApiTask);
    const managerService = createService([manager, worker]);

    const task = await managerService.dispatchTask(scope, {
      workerBotName: 'worker-a',
      prompt: 'Review the implementation diff',
      taskTemplate: 'review',
      relatedTaskId: 'mgrtask-related',
      workflowId: 'workflow-1',
      metadata: { source: 'test' },
      waitTimeoutSeconds: 1,
    });

    expect(task.prompt).toBe('Review the implementation diff');
    expect(task.metadata).toMatchObject({
      source: 'test',
      sessionKey: 'default',
      taskTemplate: 'review',
      relatedTaskId: 'mgrtask-related',
      workflowId: 'workflow-1',
      outputContractVersion: expect.any(String),
    });
    const callOptions = executeApiTask.mock.calls[0][0];
    expect(callOptions.prompt).toContain('Template: review');
    expect(callOptions.prompt).toContain('Related task ID: mgrtask-related');
    expect(callOptions.prompt).toContain('Workflow ID: workflow-1');
    expect(callOptions.prompt).toContain('Treat this as a read-only independent review');
    expect(callOptions.prompt).toContain('Review the implementation diff');
  });

  it('returns queued tasks quickly by default while worker execution continues asynchronously', async () => {
    const workerResult = deferred<ApiTaskResult>();
    const executeApiTask = vi.fn((_options: ApiTaskOptions) => workerResult.promise);
    const manager = createBot('manager', { enabled: true, workers: ['worker-a'] });
    const worker = createBot('worker-a', undefined, executeApiTask);
    const managerService = createService([manager, worker]);

    const task = await managerService.dispatchTask(scope, { workerBotName: 'worker-a', prompt: 'slow work' });

    expect(task.status).toBe('queued');
    await waitFor(() => expect(executeApiTask).toHaveBeenCalledTimes(1));

    workerResult.resolve({ success: true, responseText: 'done' });
    await waitFor(() => expect(managerService.getTask(scope, task.id)?.status).toBe('completed'));
  });

  it('attaches a new prompt to a running worker session when possible', async () => {
    const workerResult = deferred<ApiTaskResult>();
    const executeApiTask = vi.fn((_options: ApiTaskOptions) => workerResult.promise);
    const manager = createBot('manager', { enabled: true, workers: ['worker-a'] });
    const worker = createBot('worker-a', undefined, executeApiTask);
    const managerService = createService([manager, worker]);

    const task = await managerService.dispatchTask(scope, {
      workerBotName: 'worker-a',
      prompt: 'slow work',
      sessionKey: 'research',
    });
    await waitFor(() => expect(executeApiTask).toHaveBeenCalledTimes(1));

    const result = await managerService.sendWorkerPrompt(scope, {
      workerBotName: 'worker-a',
      prompt: 'add this constraint',
      sessionKey: 'research',
    });

    expect(result.mode).toBe('attached');
    expect(worker.bridge.appendPromptToRunningTask).toHaveBeenCalledWith(task.workerChatId, 'add this constraint');
    expect(managerService.getTask(scope, task.id, { includeEvents: true })?.events?.map((event) => event.type))
      .toContain('prompt_sent');

    workerResult.resolve({ success: true, responseText: 'done' });
    await waitFor(() => expect(managerService.getTask(scope, task.id)?.status).toBe('completed'));
  });

  it('dispatches a new task when sendWorkerPrompt has no running worker session', async () => {
    const manager = createBot('manager', { enabled: true, workers: ['worker-a'] });
    const worker = createBot('worker-a');
    const managerService = createService([manager, worker]);

    const result = await managerService.sendWorkerPrompt(scope, {
      workerBotName: 'worker-a',
      prompt: 'start now',
      sessionKey: 'research',
    });

    expect(result.mode).toBe('dispatched');
    expect(result.task.status).toBe('queued');
  });

  it('serializes tasks per workerChatId', async () => {
    const firstResult = deferred<ApiTaskResult>();
    const secondResult = deferred<ApiTaskResult>();
    const executeApiTask = vi.fn()
      .mockImplementationOnce((_options: ApiTaskOptions) => firstResult.promise)
      .mockImplementationOnce((_options: ApiTaskOptions) => secondResult.promise);
    const manager = createBot('manager', { enabled: true, workers: ['worker-a'] });
    const worker = createBot('worker-a', undefined, executeApiTask);
    const managerService = createService([manager, worker]);

    const first = await managerService.dispatchTask(scope, { workerBotName: 'worker-a', prompt: 'first' });
    const second = await managerService.dispatchTask(scope, { workerBotName: 'worker-a', prompt: 'second' });

    await waitFor(() => expect(executeApiTask).toHaveBeenCalledTimes(1));
    firstResult.resolve({ success: true, responseText: 'first done' });
    await waitFor(() => expect(executeApiTask).toHaveBeenCalledTimes(2));
    secondResult.resolve({ success: true, responseText: 'second done' });

    await waitFor(() => expect(managerService.getTask(scope, first.id)?.status).toBe('completed'));
    await waitFor(() => expect(managerService.getTask(scope, second.id)?.status).toBe('completed'));
  });

  it('runs different workers concurrently', async () => {
    const workerAResult = deferred<ApiTaskResult>();
    const workerBResult = deferred<ApiTaskResult>();
    const executeWorkerA = vi.fn((_options: ApiTaskOptions) => workerAResult.promise);
    const executeWorkerB = vi.fn((_options: ApiTaskOptions) => workerBResult.promise);
    const manager = createBot('manager', { enabled: true, workers: ['worker-a', 'worker-b'] });
    const workerA = createBot('worker-a', undefined, executeWorkerA);
    const workerB = createBot('worker-b', undefined, executeWorkerB);
    const managerService = createService([manager, workerA, workerB]);

    const first = await managerService.dispatchTask(scope, { workerBotName: 'worker-a', prompt: 'first' });
    const second = await managerService.dispatchTask(scope, { workerBotName: 'worker-b', prompt: 'second' });

    await waitFor(() => expect(executeWorkerA).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(executeWorkerB).toHaveBeenCalledTimes(1));
    workerAResult.resolve({ success: true, responseText: 'first done' });
    workerBResult.resolve({ success: true, responseText: 'second done' });

    await waitFor(() => expect(managerService.getTask(scope, first.id)?.status).toBe('completed'));
    await waitFor(() => expect(managerService.getTask(scope, second.id)?.status).toBe('completed'));
  });

  it('honors manager maxConcurrentWorkerTasks across different workers', async () => {
    const workerAResult = deferred<ApiTaskResult>();
    const workerBResult = deferred<ApiTaskResult>();
    const executeWorkerA = vi.fn((_options: ApiTaskOptions) => workerAResult.promise);
    const executeWorkerB = vi.fn((_options: ApiTaskOptions) => workerBResult.promise);
    const manager = createBot('manager', {
      enabled: true,
      workers: ['worker-a', 'worker-b'],
      maxConcurrentWorkerTasks: 1,
    });
    const workerA = createBot('worker-a', undefined, executeWorkerA);
    const workerB = createBot('worker-b', undefined, executeWorkerB);
    const managerService = createService([manager, workerA, workerB]);

    const first = await managerService.dispatchTask(scope, { workerBotName: 'worker-a', prompt: 'first' });
    const second = await managerService.dispatchTask(scope, { workerBotName: 'worker-b', prompt: 'second' });

    await waitFor(() => expect(executeWorkerA).toHaveBeenCalledTimes(1));
    expect(executeWorkerB).not.toHaveBeenCalled();
    await waitFor(() => expect(managerService.getTask(scope, second.id, { includeEvents: true })?.events?.map((event) => event.type))
      .toContain('concurrency_waiting'));

    workerAResult.resolve({ success: true, responseText: 'first done' });
    await waitFor(() => expect(executeWorkerB).toHaveBeenCalledTimes(1));
    workerBResult.resolve({ success: true, responseText: 'second done' });

    await waitFor(() => expect(managerService.getTask(scope, first.id)?.status).toBe('completed'));
    await waitFor(() => expect(managerService.getTask(scope, second.id)?.status).toBe('completed'));
  });

  it('cancels a running task and leaves it cancelled after the worker returns', async () => {
    const workerResult = deferred<ApiTaskResult>();
    const executeApiTask = vi.fn((_options: ApiTaskOptions) => workerResult.promise);
    const manager = createBot('manager', { enabled: true, workers: ['worker-a'] });
    const worker = createBot('worker-a', undefined, executeApiTask);
    const managerService = createService([manager, worker]);

    const task = await managerService.dispatchTask(scope, { workerBotName: 'worker-a', prompt: 'slow work' });
    await waitFor(() => expect(executeApiTask).toHaveBeenCalledTimes(1));

    expect(managerService.cancelTask(scope, task.id, 'no longer needed')).toBe(true);
    expect(worker.bridge.stopChatTask).toHaveBeenCalledWith(task.workerChatId);
    expect(managerService.getTask(scope, task.id)).toMatchObject({ status: 'cancelled', error: 'no longer needed' });
    expect(managerService.getTask(scope, task.id, { includeEvents: true })?.events?.map((event) => event.type))
      .toEqual(['created', 'queued', 'started', 'cancel_requested', 'cancelled']);

    workerResult.resolve({ success: true, responseText: 'late success' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(managerService.getTask(scope, task.id)?.status).toBe('cancelled');
  });

  it('marks interrupted tasks failed on startup', () => {
    const temp = createTempDbPath();
    tmpDir = temp.dir;
    store = new ManagerStore(createLogger(), { dbPath: temp.dbPath });
    const interrupted = store.createTask({
      managerBotName: 'manager',
      managerChatId: 'chat-a',
      workerBotName: 'worker-a',
      workerChatId: 'worker-chat',
      prompt: 'interrupted',
    });

    const manager = createBot('manager', { enabled: true, workers: ['worker-a'] });
    const worker = createBot('worker-a');
    service = new ManagerService(createRegistry([manager, worker]), createScheduler().scheduler, createLogger(), { store });

    expect(store.getTask(interrupted.id)?.status).toBe('failed');
    expect(store.listEvents(interrupted.id).map((event) => event.type)).toContain('process_recovered');
  });

  it('schedules, lists, and cancels manager-owned reminders with metadata', () => {
    const schedulerMocks = createScheduler();
    const manager = createBot('manager', { enabled: true, workers: ['worker-a'] });
    const registry = createRegistry([manager, createBot('worker-a')]);
    const temp = createTempDbPath();
    tmpDir = temp.dir;
    store = new ManagerStore(createLogger(), { dbPath: temp.dbPath });
    service = new ManagerService(registry, schedulerMocks.scheduler, createLogger(), { store });

    const reminder = service.scheduleReminder(scope, {
      prompt: 'Remember this',
      delaySeconds: 30,
      label: 'Reminder label',
      traceId: 'trace-reminder',
    });

    expect(reminder).toMatchObject({
      id: 'sched-1',
      type: 'one-time',
      botName: 'manager',
      chatId: 'chat-a',
      prompt: 'Remember this',
      label: 'Reminder label',
      metadata: {
        origin: 'manager-mcp',
        createdByBotName: 'manager',
        createdByChatId: 'chat-a',
        traceId: 'trace-reminder',
      },
    });
    expect(schedulerMocks.scheduler.scheduleTask).toHaveBeenCalledWith(expect.objectContaining({
      botName: 'manager',
      chatId: 'chat-a',
      delaySeconds: 30,
      sendCards: true,
      metadata: expect.objectContaining({ origin: 'manager-mcp' }),
    }));
    expect(service.listReminders(scope).map((item) => item.id)).toEqual(['sched-1']);
    expect(service.listReminders({ managerBotName: 'manager', managerChatId: 'other-chat' })).toEqual([]);
    expect(service.cancelReminder(scope, reminder.id)).toBe(true);
    expect(schedulerMocks.scheduler.cancelTask).toHaveBeenCalledWith('sched-1');
  });

  it('schedules recurring reminders and validates exactly one schedule mode', () => {
    const schedulerMocks = createScheduler();
    const manager = createBot('manager', { enabled: true, workers: ['worker-a'] });
    const temp = createTempDbPath();
    tmpDir = temp.dir;
    store = new ManagerStore(createLogger(), { dbPath: temp.dbPath });
    service = new ManagerService(createRegistry([manager, createBot('worker-a')]), schedulerMocks.scheduler, createLogger(), { store });

    const recurring = service.scheduleReminder(scope, {
      prompt: 'Standup',
      cronExpr: '0 9 * * 1-5',
      timezone: 'Asia/Shanghai',
    });

    expect(recurring).toMatchObject({ id: 'recur-1', type: 'recurring', cronExpr: '0 9 * * 1-5', timezone: 'Asia/Shanghai' });
    expect(schedulerMocks.scheduler.scheduleRecurring).toHaveBeenCalledWith(expect.objectContaining({
      cronExpr: '0 9 * * 1-5',
      metadata: expect.objectContaining({ origin: 'manager-mcp' }),
    }));
    expect(service.cancelReminder(scope, recurring.id)).toBe(true);
    expect(schedulerMocks.scheduler.cancelRecurring).toHaveBeenCalledWith('recur-1');

    expect(() => service!.scheduleReminder(scope, { prompt: 'bad' })).toThrow('exactly one');
    expect(() => service!.scheduleReminder(scope, { prompt: 'bad', delaySeconds: -1 })).toThrow('positive');
    expect(() => service!.scheduleReminder(scope, { prompt: 'bad', delaySeconds: 1, cronExpr: '* * * * *' })).toThrow('exactly one');
  });

  it('generates stable filesystem-safe worker chat IDs', () => {
    const one = buildWorkerChatId(scope, 'worker-a', 'session/one');
    const two = buildWorkerChatId(scope, 'worker-a', 'session/one');
    const other = buildWorkerChatId(scope, 'worker-a', 'session-two');

    expect(one).toBe(two);
    expect(one).not.toBe(other);
    expect(one).toMatch(/^manager-worker-[a-f0-9]{32}$/);
  });
});
