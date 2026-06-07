import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('better-sqlite3', async () => {
  const mod = await import('./__mocks__/better-sqlite3.js');
  return { default: mod.default };
});
import type { BotRegistry, RegisteredBot } from '../src/api/bot-registry.js';
import { ManagerService, buildWorkerChatId, type ManagerScope, type ManagerServiceOptions } from '../src/api/manager-service.js';
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

  function createService(bots: RegisteredBot[], options: Partial<ManagerServiceOptions> = {}): ManagerService {
    const temp = createTempDbPath();
    tmpDir = temp.dir;
    store = new ManagerStore(createLogger(), { dbPath: temp.dbPath });
    service = new ManagerService(createRegistry(bots), createScheduler().scheduler, createLogger(), { store, ...options });
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
      instructionContract: expect.objectContaining({
        forbiddenActions: [],
        sideEffectClass: 'unknown',
      }),
    });
    expect(executeApiTask).toHaveBeenCalledWith(expect.objectContaining({
      userId: 'manager:manager',
      sendCards: false,
    }));
    const callOptions = executeApiTask.mock.calls[0][0];
    expect(callOptions.prompt).toContain('You are executing a delegated MetaBot worker task.');
    expect(callOptions.prompt).toContain('Task ID:');
    expect(callOptions.prompt).toContain('Template: general');
    expect(callOptions.prompt).toContain('## Instruction Contract');
    expect(callOptions.prompt).toContain('Do worker work');
    expect(callOptions.chatId).toMatch(/^manager-worker-[a-f0-9]{32}$/);
    expect(callOptions.actionGatePolicy).toMatchObject({
      forbiddenActions: [],
      taskId: task.id,
      traceId: task.traceId,
    });

    await waitFor(() => expect(managerService.getTask(scope, task.id, { includeEvents: true })?.events?.map((event) => event.type))
      .toContain('manager_notified'));
    const details = managerService.getTask(scope, task.id, { includeEvents: true });
    const eventTypes = details?.events?.map((event) => event.type) ?? [];
    expect(eventTypes.slice(0, 6)).toEqual([
      'created',
      'instruction_contract',
      'queued',
      'started',
      'worker_message',
      'checkpoint',
    ]);
    expect(eventTypes).toEqual(expect.arrayContaining([
      'worker_update',
      'worker_result_invalid',
      'acceptance_report',
      'completed',
      'manager_notified',
    ]));
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

  it('derives forbidden actions from manager instructions and passes them to worker execution', async () => {
    const executeApiTask = vi.fn(async (_options: ApiTaskOptions): Promise<ApiTaskResult> => ({
      success: true,
      responseText: 'done',
    }));
    const manager = createBot('manager', { enabled: true, workers: ['worker-a'] });
    const worker = createBot('worker-a', undefined, executeApiTask);
    const managerService = createService([manager, worker]);

    const task = await managerService.dispatchTask(scope, {
      workerBotName: 'worker-a',
      prompt: '完成数据构建收尾，不要启动 train，也不要 push。',
      waitTimeoutSeconds: 1,
    });

    const callOptions = executeApiTask.mock.calls[0][0];
    expect(callOptions.actionGatePolicy).toMatchObject({
      forbiddenActions: ['train', 'push'],
      taskId: task.id,
    });
    expect(callOptions.prompt).toContain('Forbidden actions: train, push');
    const contractEvent = managerService.getTask(scope, task.id, { includeEvents: true })?.events
      ?.find((event) => event.type === 'instruction_contract');
    expect(contractEvent?.payload).toMatchObject({
      forbiddenActions: ['train', 'push'],
    });
  });

  it('records structured worker results, artifacts, and acceptance reports', async () => {
    const responseText = [
      'Implementation complete.',
      '',
      '```json METABOT_WORKER_RESULT',
      '{',
      '  "summary": "P0-P1 completed",',
      '  "actionsTaken": ["wired manager contract"],',
      '  "commands": ["npm test"],',
      '  "files": ["src/api/manager-service.ts"],',
      '  "artifacts": [{"path":"docs/report.md","type":"report","description":"trace report","sha256":"abc"}],',
      '  "verification": [{"command":"npm test","status":"passed","details":"ok"}],',
      '  "risks": [],',
      '  "nextAction": "review"',
      '}',
      '```',
    ].join('\n');
    const executeApiTask = vi.fn(async (_options: ApiTaskOptions): Promise<ApiTaskResult> => ({
      success: true,
      responseText,
      costUsd: 0.1,
      durationMs: 20,
    }));
    const manager = createBot('manager', { enabled: true, workers: ['worker-a'] });
    const worker = createBot('worker-a', undefined, executeApiTask);
    const managerService = createService([manager, worker]);

    const task = await managerService.dispatchTask(scope, {
      workerBotName: 'worker-a',
      prompt: 'Implement P0-P1',
      acceptanceCriteria: ['focused tests pass'],
      waitTimeoutSeconds: 1,
    });

    const details = managerService.getTask(scope, task.id, { includeEvents: true });
    expect(details?.metadata?.workerResult).toMatchObject({ summary: 'P0-P1 completed' });
    expect(details?.metadata?.artifactRegistry).toEqual([
      expect.objectContaining({ path: 'docs/report.md', sha256: 'abc' }),
    ]);
    expect(details?.events?.map((event) => event.type)).toEqual(expect.arrayContaining([
      'worker_result',
      'artifact_registered',
      'acceptance_report',
    ]));
    expect(details?.events?.find((event) => event.type === 'acceptance_report')?.payload)
      .toMatchObject({
        status: 'worker_reported',
        criteria: [{ criterion: 'focused tests pass', status: 'not_deterministically_verified' }],
      });
    expect(manager.sender.sendTextNotice).toHaveBeenCalledWith(
      'chat-a',
      expect.stringContaining('completed'),
      expect.stringContaining('Summary: P0-P1 completed'),
      'green',
    );
  });

  it('records action gate blocked events from worker execution', async () => {
    const executeApiTask = vi.fn(async (options: ApiTaskOptions): Promise<ApiTaskResult> => {
      options.onActionGateBlocked?.({
        allowed: false,
        action: 'train',
        command: 'npm run train',
        reason: 'Action blocked by instruction contract: train',
      });
      return { success: true, responseText: 'done' };
    });
    const manager = createBot('manager', { enabled: true, workers: ['worker-a'] });
    const worker = createBot('worker-a', undefined, executeApiTask);
    const managerService = createService([manager, worker]);

    const task = await managerService.dispatchTask(scope, {
      workerBotName: 'worker-a',
      prompt: '完成任务，不要启动 train。',
      waitTimeoutSeconds: 1,
    });

    const blocked = managerService.getTask(scope, task.id, { includeEvents: true })?.events
      ?.find((event) => event.type === 'action_gate_blocked');
    expect(blocked?.payload).toMatchObject({
      action: 'train',
      command: 'npm run train',
      reason: 'Action blocked by instruction contract: train',
      traceId: task.traceId,
    });
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

  it('retries retryable worker failures and keeps the same task id', async () => {
    const executeApiTask = vi.fn()
      .mockResolvedValueOnce({ success: false, responseText: 'partial', error: 'API Error: 429 rate_limit_error' })
      .mockResolvedValueOnce({ success: true, responseText: 'done after retry' });
    const manager = createBot('manager', { enabled: true, workers: ['worker-a'] });
    const worker = createBot('worker-a', undefined, executeApiTask);
    const managerService = createService([manager, worker], { retryDelayMs: () => 0 });

    const task = await managerService.dispatchTask(scope, { workerBotName: 'worker-a', prompt: 'retry me' });

    await waitFor(() => expect(executeApiTask).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(managerService.getTask(scope, task.id)?.status).toBe('completed'));
    const details = managerService.getTask(scope, task.id, { includeEvents: true });
    expect(details?.id).toBe(task.id);
    expect(details?.attemptCount).toBe(1);
    expect(details?.events?.map((event) => event.type)).toEqual(expect.arrayContaining([
      'retry_scheduled',
      'retry_started',
      'completed',
    ]));
  });

  it('marks retryable worker failures failed only after retry exhaustion', async () => {
    const executeApiTask = vi.fn(async () => ({
      success: false,
      responseText: '',
      error: 'HTTP 503 service unavailable',
    }));
    const manager = createBot('manager', { enabled: true, workers: ['worker-a'] });
    const worker = createBot('worker-a', undefined, executeApiTask);
    const managerService = createService([manager, worker], { retryDelayMs: () => 0 });

    const task = await managerService.dispatchTask(scope, { workerBotName: 'worker-a', prompt: 'fail eventually' });

    await waitFor(() => expect(managerService.getTask(scope, task.id)?.status).toBe('failed'));
    expect(executeApiTask).toHaveBeenCalledTimes(6);
    const events = managerService.getTask(scope, task.id, { includeEvents: true })?.events?.map((event) => event.type);
    expect(events).toEqual(expect.arrayContaining(['retry_scheduled', 'retry_exhausted', 'failed']));
  });

  it('pauses malformed-response worker retry without side-effect safety metadata', async () => {
    const executeApiTask = vi.fn()
      .mockResolvedValueOnce({
        success: false,
        responseText: 'partial',
        error: 'API returned an empty or malformed response (HTTP 200)',
      });
    const manager = createBot('manager', { enabled: true, workers: ['worker-a'] });
    const worker = createBot('worker-a', undefined, executeApiTask);
    const managerService = createService([manager, worker], { retryDelayMs: () => 0 });

    const task = await managerService.dispatchTask(scope, { workerBotName: 'worker-a', prompt: 'unsafe retry' });

    await waitFor(() => expect(managerService.getTask(scope, task.id)?.status).toBe('failed'));
    expect(executeApiTask).toHaveBeenCalledTimes(1);
    const events = managerService.getTask(scope, task.id, { includeEvents: true })?.events;
    expect(events?.map((event) => event.type)).toEqual(expect.arrayContaining(['retry_paused', 'failed']));
    expect(events?.find((event) => event.type === 'retry_paused')?.payload).toMatchObject({
      code: 'malformed_response_http_200',
      sideEffectClass: 'unknown',
    });
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
    expect(result.prompt).toBe('add this constraint');
    expect(managerService.getTask(scope, task.id, { includeEvents: true })?.events?.map((event) => event.type))
      .toContain('prompt_sent');

    workerResult.resolve({ success: true, responseText: 'done' });
    await waitFor(() => expect(managerService.getTask(scope, task.id)?.status).toBe('completed'));
  });

  it('wraps attached prompts when follow-up template metadata is provided', async () => {
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
      prompt: 'review this implementation',
      sessionKey: 'research',
      taskTemplate: 'review',
      relatedTaskId: task.id,
      workflowId: 'wf-1',
    });

    expect(result.mode).toBe('attached');
    const deliveredPrompt = (worker.bridge.appendPromptToRunningTask as any).mock.calls.at(-1)[1];
    expect(deliveredPrompt).toContain('Template: review');
    expect(deliveredPrompt).toContain(`Related task ID: ${task.id}`);
    expect(deliveredPrompt).toContain('Workflow ID: wf-1');
    expect(deliveredPrompt).toContain('Treat this as a read-only independent review');
    const promptEvent = managerService.getTask(scope, task.id, { includeEvents: true })?.events
      ?.filter((event) => event.type === 'prompt_sent')
      .at(-1);
    expect(promptEvent?.payload).toMatchObject({
      prompt: 'review this implementation',
      taskTemplate: 'review',
      relatedTaskId: task.id,
      workflowId: 'wf-1',
      outputContractVersion: expect.any(String),
    });

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
      .toEqual(['created', 'instruction_contract', 'queued', 'started', 'cancel_requested', 'cancelled']);

    workerResult.resolve({ success: true, responseText: 'late success' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(managerService.getTask(scope, task.id)?.status).toBe('cancelled');
  });

  it('requeues interrupted tasks on startup', async () => {
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
    const workerResult = deferred<ApiTaskResult>();
    const executeApiTask = vi.fn((_options: ApiTaskOptions) => workerResult.promise);
    const worker = createBot('worker-a', undefined, executeApiTask);
    service = new ManagerService(createRegistry([manager, worker]), createScheduler().scheduler, createLogger(), { store });

    expect(store.getTask(interrupted.id)?.status).toBe('queued');
    const recoveredEvents = store.listEvents(interrupted.id).map((event) => event.type);
    expect(recoveredEvents).toContain('process_recovered');
    expect(recoveredEvents).toContain('resume_queued');
    await waitFor(() => expect(executeApiTask).toHaveBeenCalledTimes(1));
    workerResult.resolve({ success: true, responseText: 'recovered' });
    await waitFor(() => expect(store.getTask(interrupted.id)?.status).toBe('completed'));
  });

  it('resumes failed or queued tasks and rejects completed tasks', async () => {
    const workerResult = deferred<ApiTaskResult>();
    const executeApiTask = vi.fn((_options: ApiTaskOptions) => workerResult.promise);
    const manager = createBot('manager', { enabled: true, workers: ['worker-a'] });
    const worker = createBot('worker-a', undefined, executeApiTask);
    const managerService = createService([manager, worker]);

    const failed = store!.createTask({
      managerBotName: 'manager',
      managerChatId: 'chat-a',
      workerBotName: 'worker-a',
      workerChatId: 'manager-worker-resume',
      prompt: 'resume me',
    });
    store!.updateTask(failed.id, { status: 'failed', completedAt: Date.now(), error: 'transient' });
    const resumed = managerService.resumeTask(scope, failed.id);

    expect(resumed.status).toBe('queued');
    expect(managerService.getTask(scope, failed.id, { includeEvents: true })?.events?.map((event) => event.type))
      .toContain('resume_queued');
    workerResult.resolve({ success: true, responseText: 'resumed' });
    await waitFor(() => expect(managerService.getTask(scope, failed.id)?.status).toBe('completed'));
    expect(() => managerService.resumeTask(scope, failed.id)).toThrow('cannot be resumed');
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
