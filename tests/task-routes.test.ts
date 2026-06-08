import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import { handleTaskRoutes } from '../src/api/routes/task-routes.js';
import type { RouteContext } from '../src/api/routes/types.js';
import type { ScheduleInput } from '../src/scheduler/task-scheduler.js';

const DELAY_SECONDS = 60;

function req(body?: unknown): any {
  const chunks = body === undefined ? [] : [Buffer.from(JSON.stringify(body))];
  const stream = Readable.from(chunks) as any;
  stream.headers = { host: 'localhost' };
  return stream;
}

function res(): any {
  return {
    statusCode: 0,
    body: undefined as unknown,
    writeHead: vi.fn(function (this: any, status: number) {
      this.statusCode = status;
    }),
    end: vi.fn(function (this: any, body: string) {
      this.body = JSON.parse(body);
    }),
  };
}

function ctx(scheduleTask = scheduleTaskMock()): RouteContext {
  return {
    registry: { get: vi.fn(() => ({ name: 'bot-a' })) },
    scheduler: { scheduleTask },
    logger: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
  } as unknown as RouteContext;
}

function scheduleTaskMock(): ReturnType<typeof vi.fn> {
  return vi.fn((input: ScheduleInput) => ({
    id: 'sched-1',
    type: 'one-time',
    ...input,
    executeAt: Date.now() + input.delaySeconds * 1000,
    status: 'pending',
    createdAt: Date.now(),
    retryCount: 0,
  }));
}

describe('task routes', () => {
  it('normalizes API schedule trace metadata for one-time tasks', async () => {
    const scheduleTask = scheduleTaskMock();
    const out = res();
    const handled = await handleTaskRoutes(
      ctx(scheduleTask),
      req({
        botName: 'bot-a',
        chatId: 'chat-a',
        prompt: 'remember',
        delaySeconds: DELAY_SECONDS,
        workflowId: 'wf-api',
        sideEffectClass: 'localWrite',
        idempotencyKey: 'idem-api',
      }),
      out,
      'POST',
      '/api/schedule',
    );

    expect(handled).toBe(true);
    expect(out.statusCode).toBe(201);
    expect(scheduleTask).toHaveBeenCalledWith(expect.objectContaining({
      metadata: expect.objectContaining({
        origin: 'api',
        createdByBotName: 'bot-a',
        createdByChatId: 'chat-a',
        workflowId: 'wf-api',
        traceId: expect.stringMatching(/^trace-/),
        sideEffectClass: 'localWrite',
        idempotencyKey: 'idem-api',
      }),
    }));
    expect(out.body.metadata).toMatchObject({
      origin: 'api',
      createdByBotName: 'bot-a',
      createdByChatId: 'chat-a',
      workflowId: 'wf-api',
      sideEffectClass: 'localWrite',
      idempotencyKey: 'idem-api',
    });
  });
});
