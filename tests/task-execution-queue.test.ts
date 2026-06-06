import { describe, expect, it } from 'vitest';
import { TaskExecutionQueue } from '../src/utils/task-execution-queue.js';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => { resolve = res; });
  return { promise, resolve };
}

async function tick(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 0));
}

describe('TaskExecutionQueue', () => {
  it('enforces global concurrency', async () => {
    const queue = new TaskExecutionQueue({ maxConcurrentTasks: 2, maxConcurrentTasksPerChat: 10, maxBackgroundWorkerTasks: 10 });
    const first = deferred<void>();
    const second = deferred<void>();
    const third = deferred<void>();
    const starts: string[] = [];

    const p1 = queue.enqueue({ botName: 'bot', chatId: 'a', source: 'api-sync', run: async () => { starts.push('1'); await first.promise; return '1'; } });
    const p2 = queue.enqueue({ botName: 'bot', chatId: 'b', source: 'api-sync', run: async () => { starts.push('2'); await second.promise; return '2'; } });
    const p3 = queue.enqueue({ botName: 'bot', chatId: 'c', source: 'api-sync', run: async () => { starts.push('3'); await third.promise; return '3'; } });

    await tick();
    expect(starts).toEqual(['1', '2']);
    first.resolve();
    await tick();
    expect(starts).toEqual(['1', '2', '3']);
    second.resolve();
    third.resolve();
    await expect(Promise.all([p1, p2, p3])).resolves.toEqual(['1', '2', '3']);
  });

  it('enforces per-chat concurrency', async () => {
    const queue = new TaskExecutionQueue({ maxConcurrentTasks: 10, maxConcurrentTasksPerChat: 2, maxBackgroundWorkerTasks: 10 });
    const first = deferred<void>();
    const second = deferred<void>();
    const third = deferred<void>();
    const starts: string[] = [];

    const enqueue = (id: string, gate: ReturnType<typeof deferred<void>>) => queue.enqueue({
      botName: 'bot', chatId: 'same-chat', source: 'api-sync',
      run: async () => { starts.push(id); await gate.promise; return id; },
    });

    const p1 = enqueue('1', first);
    const p2 = enqueue('2', second);
    const p3 = enqueue('3', third);

    await tick();
    expect(starts).toEqual(['1', '2']);
    first.resolve();
    await tick();
    expect(starts).toEqual(['1', '2', '3']);
    second.resolve();
    third.resolve();
    await expect(Promise.all([p1, p2, p3])).resolves.toEqual(['1', '2', '3']);
  });

  it('enforces background worker concurrency', async () => {
    const queue = new TaskExecutionQueue({ maxConcurrentTasks: 10, maxConcurrentTasksPerChat: 10, maxBackgroundWorkerTasks: 1 });
    const first = deferred<void>();
    const second = deferred<void>();
    const starts: string[] = [];

    const p1 = queue.enqueue({ botName: 'bot', chatId: 'a', source: 'manager-worker', backgroundWorker: true, run: async () => { starts.push('1'); await first.promise; return '1'; } });
    const p2 = queue.enqueue({ botName: 'bot', chatId: 'b', source: 'manager-worker', backgroundWorker: true, run: async () => { starts.push('2'); await second.promise; return '2'; } });

    await tick();
    expect(starts).toEqual(['1']);
    first.resolve();
    await tick();
    expect(starts).toEqual(['1', '2']);
    second.resolve();
    await expect(Promise.all([p1, p2])).resolves.toEqual(['1', '2']);
  });

  it('releases slots after failures', async () => {
    const queue = new TaskExecutionQueue({ maxConcurrentTasks: 1, maxConcurrentTasksPerChat: 1, maxBackgroundWorkerTasks: 1 });
    const starts: string[] = [];

    const first = queue.enqueue({
      botName: 'bot',
      chatId: 'chat',
      source: 'api-sync',
      run: async () => {
        starts.push('first');
        throw new Error('boom');
      },
    });
    const second = queue.enqueue({
      botName: 'bot',
      chatId: 'chat',
      source: 'api-sync',
      run: async () => {
        starts.push('second');
        return 'ok';
      },
    });

    await expect(first).rejects.toThrow('boom');
    await expect(second).resolves.toBe('ok');
    expect(starts).toEqual(['first', 'second']);
  });
});
