import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('better-sqlite3', async () => {
  const mod = await import('./__mocks__/better-sqlite3.js');
  return { default: mod.default };
});

import { ManagerStore } from '../src/api/manager-store.js';
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'manager-store-test-'));
  return { dir, dbPath: path.join(dir, 'manager.db') };
}

describe('ManagerStore', () => {
  let store: ManagerStore | undefined;
  let tmpDir: string | undefined;

  afterEach(() => {
    store?.close();
    store = undefined;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  function createStore(): ManagerStore {
    const temp = createTempDbPath();
    tmpDir = temp.dir;
    store = new ManagerStore(createLogger(), { dbPath: temp.dbPath });
    return store;
  }

  it('creates and retrieves a queued task with a created event', () => {
    const managerStore = createStore();

    const task = managerStore.createTask({
      traceId: 'trace-1',
      managerBotName: 'manager',
      managerChatId: 'chat-a',
      workerBotName: 'worker',
      workerChatId: 'manager-worker-abc',
      label: 'Build feature',
      prompt: 'Implement it',
      metadata: { priority: 'high' },
    });

    expect(task.id).toMatch(/^mgrtask-/);
    expect(task.traceId).toBe('trace-1');
    expect(task.status).toBe('queued');
    expect(task.createdAt).toBeGreaterThan(0);

    const retrieved = managerStore.getTask(task.id);
    expect(retrieved).toMatchObject({
      id: task.id,
      traceId: 'trace-1',
      managerBotName: 'manager',
      managerChatId: 'chat-a',
      workerBotName: 'worker',
      workerChatId: 'manager-worker-abc',
      label: 'Build feature',
      prompt: 'Implement it',
      status: 'queued',
      metadata: { priority: 'high' },
    });

    const events = managerStore.listEvents(task.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ taskId: task.id, type: 'created', payload: { traceId: 'trace-1' } });
  });

  it('updates task result fields and appends events in order', () => {
    const managerStore = createStore();
    const task = managerStore.createTask({
      managerBotName: 'manager',
      managerChatId: 'chat-a',
      workerBotName: 'worker',
      workerChatId: 'manager-worker-abc',
      prompt: 'Do work',
    });

    managerStore.appendEvent(task.id, 'queued', { workerChatId: task.workerChatId });
    const startedAt = Date.now();
    managerStore.updateTask(task.id, { status: 'running', startedAt });
    managerStore.appendEvent(task.id, 'started');
    const completedAt = Date.now();
    managerStore.updateTask(task.id, {
      status: 'completed',
      completedAt,
      costUsd: 0.12,
      durationMs: 42,
      resultText: 'done',
    });
    managerStore.appendEvent(task.id, 'completed', { costUsd: 0.12 });

    const updated = managerStore.getTask(task.id);
    expect(updated).toMatchObject({
      status: 'completed',
      startedAt,
      completedAt,
      costUsd: 0.12,
      durationMs: 42,
      resultText: 'done',
    });
    expect(managerStore.listEvents(task.id).map((event) => event.type)).toEqual([
      'created',
      'queued',
      'started',
      'completed',
    ]);
  });

  it('lists bounded events by type and previews large payloads explicitly', () => {
    const managerStore = createStore();
    const task = managerStore.createTask({
      managerBotName: 'manager',
      managerChatId: 'chat-a',
      workerBotName: 'worker',
      workerChatId: 'manager-worker-abc',
      prompt: 'Do work',
    });

    managerStore.appendEvent(task.id, 'worker_update', { responseText: 'first' });
    managerStore.appendEvent(task.id, 'checkpoint', { responseText: 'middle' });
    managerStore.appendEvent(task.id, 'worker_update', { responseText: 'x'.repeat(2500) });

    const latestUpdate = managerStore.listEvents(task.id, {
      type: 'worker_update',
      limit: 1,
      payload: 'preview',
    });

    expect(latestUpdate).toHaveLength(1);
    expect(latestUpdate[0]).toMatchObject({
      type: 'worker_update',
      payload: { truncated: true, originalLength: expect.any(Number) },
    });
  });

  it('archives oversized event payloads outside the manager event table', () => {
    const temp = createTempDbPath();
    tmpDir = temp.dir;
    const archiveDir = path.join(temp.dir, 'event-payloads');
    store = new ManagerStore(createLogger(), {
      dbPath: temp.dbPath,
      eventPayloadArchiveDir: archiveDir,
      maxInlineEventPayloadBytes: 128,
    });
    const task = store.createTask({
      managerBotName: 'manager',
      managerChatId: 'chat-a',
      workerBotName: 'worker',
      workerChatId: 'manager-worker-abc',
      prompt: 'Do work',
    });
    const responseText = 'x'.repeat(2048);

    store.appendEvent(task.id, 'worker_update', { responseText, status: 'running' });

    const preview = store.listEvents(task.id, { type: 'worker_update', payload: 'preview' })[0];
    expect(preview.payload).toMatchObject({
      payloadArchived: true,
      archiveRef: expect.any(String),
      sha256: expect.any(String),
      originalBytes: expect.any(Number),
    });
    expect(fs.existsSync(path.join(archiveDir, String(preview.payload?.archiveRef)))).toBe(true);
    const full = store.listEvents(task.id, { type: 'worker_update', payload: 'full' })[0];
    expect(full.payload).toEqual({ responseText, status: 'running' });
  });

  it('lists tasks by manager scope, status, worker, and limit', () => {
    const managerStore = createStore();
    const first = managerStore.createTask({
      managerBotName: 'manager',
      managerChatId: 'chat-a',
      workerBotName: 'worker-a',
      workerChatId: 'chat-worker-a',
      prompt: 'first',
    });
    managerStore.updateTask(first.id, { status: 'completed', completedAt: Date.now() });
    managerStore.createTask({
      managerBotName: 'manager',
      managerChatId: 'chat-a',
      workerBotName: 'worker-b',
      workerChatId: 'chat-worker-b',
      prompt: 'second',
    });
    managerStore.createTask({
      managerBotName: 'other-manager',
      managerChatId: 'chat-a',
      workerBotName: 'worker-b',
      workerChatId: 'chat-worker-b',
      prompt: 'third',
    });

    expect(managerStore.listTasks({ managerBotName: 'manager', managerChatId: 'chat-a' })).toHaveLength(2);
    expect(managerStore.listTasks({ managerBotName: 'manager', managerChatId: 'chat-a', status: 'queued' })).toHaveLength(1);
    expect(managerStore.listTasks({ managerBotName: 'manager', managerChatId: 'chat-a', workerBotName: 'worker-a' })).toHaveLength(1);
    expect(managerStore.listTasks({ limit: 1 })).toHaveLength(1);
  });

  it('persists tasks across store instances', () => {
    const temp = createTempDbPath();
    tmpDir = temp.dir;

    const firstStore = new ManagerStore(createLogger(), { dbPath: temp.dbPath });
    const task = firstStore.createTask({
      managerBotName: 'manager',
      managerChatId: 'chat-a',
      workerBotName: 'worker',
      workerChatId: 'manager-worker-abc',
      prompt: 'persist me',
    });
    firstStore.appendEvent(task.id, 'queued');
    firstStore.close();

    store = new ManagerStore(createLogger(), { dbPath: temp.dbPath });
    expect(store.getTask(task.id)?.prompt).toBe('persist me');
    expect(store.listEvents(task.id).map((event) => event.type)).toEqual(['created', 'queued']);
  });

  it('marks interrupted queued and running tasks as failed with recovery events', () => {
    const managerStore = createStore();
    const queued = managerStore.createTask({
      managerBotName: 'manager',
      managerChatId: 'chat-a',
      workerBotName: 'worker',
      workerChatId: 'chat-worker',
      prompt: 'queued',
    });
    const running = managerStore.createTask({
      managerBotName: 'manager',
      managerChatId: 'chat-a',
      workerBotName: 'worker',
      workerChatId: 'chat-worker',
      prompt: 'running',
    });
    managerStore.updateTask(running.id, { status: 'running', startedAt: Date.now() });
    const completed = managerStore.createTask({
      managerBotName: 'manager',
      managerChatId: 'chat-a',
      workerBotName: 'worker',
      workerChatId: 'chat-worker',
      prompt: 'completed',
    });
    managerStore.updateTask(completed.id, { status: 'completed', completedAt: Date.now() });

    const count = managerStore.markInterruptedTasksFailed('restart');

    expect(count).toBe(2);
    expect(managerStore.getTask(queued.id)).toMatchObject({ status: 'failed', error: 'restart' });
    expect(managerStore.getTask(running.id)).toMatchObject({ status: 'failed', error: 'restart' });
    expect(managerStore.getTask(completed.id)?.status).toBe('completed');
    expect(managerStore.listEvents(queued.id).map((event) => event.type)).toContain('process_recovered');
    expect(managerStore.listEvents(running.id).map((event) => event.type)).toContain('failed');
  });

  it('recovers interrupted tasks by requeueing when attempts remain', () => {
    const managerStore = createStore();
    const task = managerStore.createTask({
      managerBotName: 'manager',
      managerChatId: 'chat-a',
      workerBotName: 'worker',
      workerChatId: 'chat-worker',
      prompt: 'recover',
      metadata: { sideEffectClass: 'readOnly' },
    });
    managerStore.updateTask(task.id, { status: 'running', startedAt: Date.now() });

    const recovered = managerStore.recoverInterruptedTasks('restart');

    expect(recovered.requeued.map((item) => item.id)).toContain(task.id);
    expect(recovered.paused).toEqual([]);
    expect(managerStore.getTask(task.id)).toMatchObject({
      status: 'queued',
      lastRetryReason: 'restart',
      metadata: {
        sideEffectClass: 'readOnly',
        retryResume: true,
        recoveryStatus: 'auto_resumed',
      },
    });
    expect(managerStore.listEvents(task.id).map((event) => event.type)).toEqual(expect.arrayContaining([
      'process_recovered',
      'resume_queued',
    ]));
  });

  it('pauses interrupted tasks that need side-effect recovery review', () => {
    const managerStore = createStore();
    const task = managerStore.createTask({
      managerBotName: 'manager',
      managerChatId: 'chat-a',
      workerBotName: 'worker',
      workerChatId: 'chat-worker',
      prompt: 'external write',
      metadata: { sideEffectClass: 'externalWrite' },
    });
    managerStore.updateTask(task.id, { status: 'running', startedAt: Date.now() });

    const recovered = managerStore.recoverInterruptedTasks('restart');

    expect(recovered.requeued).toEqual([]);
    expect(recovered.paused.map((item) => item.id)).toContain(task.id);
    expect(managerStore.getTask(task.id)).toMatchObject({
      status: 'failed',
      lastRetryReason: 'restart',
      metadata: {
        sideEffectClass: 'externalWrite',
        recoveryStatus: 'needs_resume_review',
      },
    });
    expect(managerStore.listEvents(task.id).map((event) => event.type)).toEqual(expect.arrayContaining([
      'process_recovered',
      'retry_paused',
      'failed',
    ]));
  });
});
