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
    cancelTask: vi.fn(() => true),
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
      }),
      createOut,
      'POST',
      '/api/manager/reminders',
    );
    expect(createOut.statusCode).toBe(201);
    expect(createOut.body.reminder.id).toBe('sched-1');

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
