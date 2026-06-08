import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleManagerRoutes } from '../src/api/routes/manager-routes.js';
import type { RouteContext } from '../src/api/routes/types.js';

function req(body?: unknown): any {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const stream = Readable.from(chunks) as any;
  stream.headers = { host: 'localhost' };
  return stream;
}

function res(): any {
  return {
    statusCode: 0,
    body: undefined as any,
    writeHead: vi.fn(function (this: any, status: number) {
      this.statusCode = status;
    }),
    end: vi.fn(function (this: any, body: string) {
      this.body = JSON.parse(body);
    }),
  };
}

function ctx(service: any): RouteContext {
  return {
    managerService: service,
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as RouteContext;
}

function service() {
  return {
    listWorkers: vi.fn(() => [{ name: 'worker-a', status: 'idle', busy: false, queuedTaskCount: 0 }]),
    dispatchTask: vi.fn(async () => ({
      id: 'mgrtask-1',
      traceId: 'trace-1',
      managerBotName: 'manager',
      managerChatId: 'chat-a',
      workerBotName: 'worker-a',
      workerChatId: 'manager-worker-abc',
      prompt: 'do it',
      status: 'queued',
      createdAt: 1,
      updatedAt: 1,
    })),
    listTasks: vi.fn(() => []),
    listTasksForManager: vi.fn(() => [{
      id: 'mgrtask-recent',
      traceId: 'trace-recent',
      managerBotName: 'manager',
      managerChatId: 'chat-b',
      workerBotName: 'worker-a',
      workerChatId: 'manager-worker-def',
      prompt: 'x'.repeat(300),
      status: 'running',
      createdAt: 1,
      updatedAt: 2,
      nextAttemptAt: Date.now() + 60_000,
      lastRetryReason: 'retry soon',
      lastCheckpointAt: 2,
      resultText: 'large result',
      metadata: {
        hidden: true,
        workflowId: 'wf-recent',
        relatedTaskId: 'mgrtask-parent',
        sideEffectClass: 'readOnly',
        lastCheckpointPreview: 'checkpoint preview',
      },
    }]),
    getTask: vi.fn(() => ({
      id: 'mgrtask-1',
      traceId: 'trace-1',
      managerBotName: 'manager',
      managerChatId: 'chat-a',
      workerBotName: 'worker-a',
      workerChatId: 'manager-worker-abc',
      prompt: 'do it',
      status: 'completed',
      createdAt: 1,
      updatedAt: 2,
      events: [{ id: 'evt-1', taskId: 'mgrtask-1', type: 'completed', createdAt: 2 }],
    })),
    getTaskSummary: vi.fn(() => ({
      taskId: 'mgrtask-1',
      traceId: 'trace-1',
      status: 'completed',
      substatus: 'completed',
      workerBotName: 'worker-a',
      summaryMarkdown: '## 完成情况',
      traceCoverage: { unsupportedClaim: false },
    })),
    getWorkflowSummary: vi.fn(() => ({
      workflowId: 'wf-1',
      workerCount: 1,
      cancelledWorkers: 0,
      actualCostUsd: 0.1,
      summaryMarkdown: '## Worker trace',
      traceCoverage: { unsupportedClaims: 0 },
      tasks: [],
    })),
    cancelTask: vi.fn(() => true),
    cancelTaskDetailed: vi.fn(() => ({
      taskId: 'mgrtask-1',
      cancelled: true,
      status: 'cancelled',
      reason: 'Cancelled via manager API',
      stopped: true,
      currentStatus: 'cancelled',
    })),
    resumeTask: vi.fn(() => ({
      id: 'mgrtask-1',
      traceId: 'trace-1',
      managerBotName: 'manager',
      managerChatId: 'chat-a',
      workerBotName: 'worker-a',
      workerChatId: 'manager-worker-abc',
      prompt: 'do it',
      status: 'queued',
      createdAt: 1,
      updatedAt: 3,
    })),
    scheduleReminder: vi.fn(() => ({
      id: 'sched-1',
      type: 'one-time',
      botName: 'manager',
      chatId: 'chat-a',
      prompt: 'remember',
      executeAt: 1,
      sendCards: true,
      status: 'pending',
      createdAt: 1,
    })),
    listReminders: vi.fn(() => []),
    cancelReminder: vi.fn(() => true),
  };
}

describe('manager routes', () => {
  it('lists workers with manager scope query params', async () => {
    const svc = service();
    const out = res();
    const handled = await handleManagerRoutes(
      ctx(svc),
      req(),
      out,
      'GET',
      '/api/manager/workers?managerBotName=manager&managerChatId=chat-a',
    );
    expect(handled).toBe(true);
    expect(out.statusCode).toBe(200);
    expect(out.body.workers[0].name).toBe('worker-a');
    expect(svc.listWorkers).toHaveBeenCalledWith({ managerBotName: 'manager', managerChatId: 'chat-a' });
  });

  it('invokes manager tools for Codex MCP proxy calls', async () => {
    const svc = service();
    const out = res();
    const handled = await handleManagerRoutes(
      ctx(svc),
      req({
        managerBotName: 'manager',
        managerChatId: 'chat-a',
        args: {},
      }),
      out,
      'POST',
      '/api/manager/tools/list_workers',
    );
    expect(handled).toBe(true);
    expect(out.statusCode).toBe(200);
    expect(out.body).toMatchObject({
      ok: true,
      workers: [{ name: 'worker-a' }],
    });
    expect(svc.listWorkers).toHaveBeenCalledWith({ managerBotName: 'manager', managerChatId: 'chat-a' });
  });

  it('dispatches worker tasks with template and trace-link fields', async () => {
    const svc = service();
    const out = res();
    await handleManagerRoutes(
      ctx(svc),
      req({
        managerBotName: 'manager',
        managerChatId: 'chat-a',
        workerBotName: 'worker-a',
        prompt: 'do it',
        taskTemplate: 'review',
        relatedTaskId: 'mgrtask-related',
        workflowId: 'wf-1',
        forbiddenActions: ['train'],
        acceptanceCriteria: ['tests pass'],
      }),
      out,
      'POST',
      '/api/manager/tasks',
    );
    expect(out.statusCode).toBe(201);
    expect(out.body.task.id).toBe('mgrtask-1');
    expect(svc.dispatchTask).toHaveBeenCalledWith(
      { managerBotName: 'manager', managerChatId: 'chat-a' },
      expect.objectContaining({
        workerBotName: 'worker-a',
        prompt: 'do it',
        taskTemplate: 'review',
        relatedTaskId: 'mgrtask-related',
        workflowId: 'wf-1',
        forbiddenActions: ['train'],
        acceptanceCriteria: ['tests pass'],
      }),
    );
  });

  it('gets task details with events', async () => {
    const svc = service();
    const out = res();
    await handleManagerRoutes(
      ctx(svc),
      req(),
      out,
      'GET',
      '/api/manager/tasks/mgrtask-1?managerBotName=manager&managerChatId=chat-a&includeEvents=true',
    );
    expect(out.statusCode).toBe(200);
    expect(out.body.task.id).toBe('mgrtask-1');
    expect(out.body.events[0].type).toBe('completed');
  });

  it('lists recent manager tasks by manager bot without requiring a chat scope', async () => {
    const svc = service();
    const out = res();
    await handleManagerRoutes(
      ctx(svc),
      req(),
      out,
      'GET',
      '/api/manager/tasks/recent?managerBotName=manager&status=running&limit=20',
    );
    expect(out.statusCode).toBe(200);
    expect(out.body.tasks[0].id).toBe('mgrtask-recent');
    expect(out.body.tasks[0].prompt).toHaveLength(243);
    expect(out.body.tasks[0]).toMatchObject({
      workflowId: 'wf-recent',
      relatedTaskId: 'mgrtask-parent',
      sideEffectClass: 'readOnly',
      substatus: 'running',
      availableActions: ['cancel'],
      lastCheckpointPreview: 'checkpoint preview',
    });
    expect(out.body.tasks[0].nextAttemptAt).toBeTruthy();
    expect(out.body.tasks[0].resultText).toBeUndefined();
    expect(out.body.tasks[0].metadata).toBeUndefined();
    expect(svc.listTasksForManager).toHaveBeenCalledWith('manager', {
      managerChatId: undefined,
      workerBotName: undefined,
      status: 'running',
      limit: 20,
    });
  });

  it('returns task and workflow work log summaries', async () => {
    const svc = service();
    const taskOut = res();
    await handleManagerRoutes(
      ctx(svc),
      req(),
      taskOut,
      'GET',
      '/api/manager/tasks/mgrtask-1/summary?managerBotName=manager&managerChatId=chat-a',
    );
    expect(taskOut.statusCode).toBe(200);
    expect(taskOut.body.summary.summaryMarkdown).toContain('完成情况');
    expect(svc.getTaskSummary).toHaveBeenCalledWith(
      { managerBotName: 'manager', managerChatId: 'chat-a' },
      'mgrtask-1',
    );

    const workflowOut = res();
    await handleManagerRoutes(
      ctx(svc),
      req(),
      workflowOut,
      'GET',
      '/api/manager/workflows/wf-1/summary?managerBotName=manager&managerChatId=chat-a',
    );
    expect(workflowOut.statusCode).toBe(200);
    expect(workflowOut.body.summary.workerCount).toBe(1);
    expect(svc.getWorkflowSummary).toHaveBeenCalledWith(
      { managerBotName: 'manager', managerChatId: 'chat-a' },
      'wf-1',
    );
  });

  it('gets filtered task events with bounded preview options', async () => {
    const svc = service();
    const out = res();
    await handleManagerRoutes(
      ctx(svc),
      req(),
      out,
      'GET',
      '/api/manager/tasks/mgrtask-1/events?managerBotName=manager&managerChatId=chat-a&limit=5&type=completed&payload=preview',
    );
    expect(out.statusCode).toBe(200);
    expect(out.body.events[0].type).toBe('completed');
    expect(svc.getTask).toHaveBeenCalledWith(
      { managerBotName: 'manager', managerChatId: 'chat-a' },
      'mgrtask-1',
      {
        includeEvents: true,
        eventLimit: 5,
        eventPayload: 'preview',
        eventType: 'completed',
      },
    );
  });

  it('rejects invalid manager event filters', async () => {
    const svc = service();
    const invalidType = res();
    await handleManagerRoutes(
      ctx(svc),
      req(),
      invalidType,
      'GET',
      '/api/manager/tasks/mgrtask-1/events?managerBotName=manager&managerChatId=chat-a&type=not_real',
    );
    expect(invalidType.statusCode).toBe(400);
    expect(invalidType.body.error).toContain('Invalid manager event type');

    const invalidPayload = res();
    await handleManagerRoutes(
      ctx(svc),
      req(),
      invalidPayload,
      'GET',
      '/api/manager/tasks/mgrtask-1/events?managerBotName=manager&managerChatId=chat-a&payload=raw',
    );
    expect(invalidPayload.statusCode).toBe(400);
    expect(invalidPayload.body.error).toContain('Invalid event payload mode');
  });

  it('resumes manager tasks', async () => {
    const svc = service();
    const out = res();
    await handleManagerRoutes(
      ctx(svc),
      req({
        managerBotName: 'manager',
        managerChatId: 'chat-a',
      }),
      out,
      'POST',
      '/api/manager/tasks/mgrtask-1/resume',
    );
    expect(out.statusCode).toBe(200);
    expect(out.body.task.status).toBe('queued');
    expect(svc.resumeTask).toHaveBeenCalledWith({ managerBotName: 'manager', managerChatId: 'chat-a' }, 'mgrtask-1');
  });

  it('returns structured cancel outcomes for manager tasks', async () => {
    const svc = service();
    const out = res();
    await handleManagerRoutes(
      ctx(svc),
      req({
        managerBotName: 'manager',
        managerChatId: 'chat-a',
        reason: 'stop now',
      }),
      out,
      'POST',
      '/api/manager/tasks/mgrtask-1/cancel',
    );
    expect(out.statusCode).toBe(200);
    expect(out.body).toMatchObject({
      taskId: 'mgrtask-1',
      cancelled: true,
      status: 'cancelled',
      stopped: true,
    });
    expect(svc.cancelTaskDetailed).toHaveBeenCalledWith(
      { managerBotName: 'manager', managerChatId: 'chat-a' },
      'mgrtask-1',
      'stop now',
    );
  });

  it('returns conflict when cancel cannot confirm worker stop', async () => {
    const svc = service();
    svc.cancelTaskDetailed.mockReturnValueOnce({
      taskId: 'mgrtask-running',
      cancelled: false,
      status: 'cancel_failed_to_stop',
      reason: 'stop now',
      stopped: false,
      currentStatus: 'running',
      workerBotName: 'worker-a',
    });
    const out = res();
    await handleManagerRoutes(
      ctx(svc),
      req({
        managerBotName: 'manager',
        managerChatId: 'chat-a',
        reason: 'stop now',
      }),
      out,
      'POST',
      '/api/manager/tasks/mgrtask-running/cancel',
    );
    expect(out.statusCode).toBe(409);
    expect(out.body).toMatchObject({
      cancelled: false,
      status: 'cancel_failed_to_stop',
      error: expect.stringContaining('stop not confirmed'),
    });
  });

  it('schedules and cancels reminders', async () => {
    const svc = service();
    const createOut = res();
    await handleManagerRoutes(
      ctx(svc),
      req({
        managerBotName: 'manager',
        managerChatId: 'chat-a',
        prompt: 'remember',
        delaySeconds: 60,
        workflowId: 'wf-reminder',
      }),
      createOut,
      'POST',
      '/api/manager/reminders',
    );
    expect(createOut.statusCode).toBe(201);
    expect(createOut.body.reminder.id).toBe('sched-1');
    expect(svc.scheduleReminder).toHaveBeenCalledWith(
      { managerBotName: 'manager', managerChatId: 'chat-a' },
      expect.objectContaining({ workflowId: 'wf-reminder' }),
    );

    const deleteOut = res();
    await handleManagerRoutes(
      ctx(svc),
      req(),
      deleteOut,
      'DELETE',
      '/api/manager/reminders/sched-1?managerBotName=manager&managerChatId=chat-a',
    );
    expect(deleteOut.statusCode).toBe(200);
    expect(svc.cancelReminder).toHaveBeenCalledWith({ managerBotName: 'manager', managerChatId: 'chat-a' }, 'sched-1');
  });
});
