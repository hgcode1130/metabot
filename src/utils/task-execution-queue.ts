export interface TaskExecutionLimits {
  maxConcurrentTasks: number;
  maxConcurrentTasksPerChat: number;
  maxBackgroundWorkerTasks: number;
}

export const DEFAULT_TASK_EXECUTION_LIMITS: TaskExecutionLimits = {
  maxConcurrentTasks: 10,
  maxConcurrentTasksPerChat: 2,
  maxBackgroundWorkerTasks: 4,
};

export type TaskExecutionSource =
  | 'interactive'
  | 'api-sync'
  | 'api-async'
  | 'scheduler'
  | 'manager-worker';

export interface TaskExecutionQueueItem<T> {
  botName: string;
  chatId: string;
  source: TaskExecutionSource;
  backgroundWorker?: boolean;
  chatSlots?: number;
  run: () => Promise<T>;
}

interface PendingItem<T> extends TaskExecutionQueueItem<T> {
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
  sequence: number;
}

export interface TaskExecutionQueueSnapshot {
  activeGlobal: number;
  activeBackgroundWorkers: number;
  pending: number;
  activeByChat: Record<string, number>;
  limits: TaskExecutionLimits;
}

export class TaskExecutionQueue {
  private activeGlobal = 0;
  private activeBackgroundWorkers = 0;
  private activeByChat = new Map<string, number>();
  private pending: Array<PendingItem<unknown>> = [];
  private sequence = 0;

  constructor(private readonly limits: TaskExecutionLimits = DEFAULT_TASK_EXECUTION_LIMITS) {
    validateLimits(limits);
  }

  enqueue<T>(item: TaskExecutionQueueItem<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.pending.push(this.pendingItem(item, resolve, reject));
      this.drain();
    });
  }

  snapshot(): TaskExecutionQueueSnapshot {
    return {
      activeGlobal: this.activeGlobal,
      activeBackgroundWorkers: this.activeBackgroundWorkers,
      pending: this.pending.length,
      activeByChat: Object.fromEntries(this.activeByChat.entries()),
      limits: { ...this.limits },
    };
  }

  private pendingItem<T>(
    item: TaskExecutionQueueItem<T>,
    resolve: (value: T) => void,
    reject: (reason?: unknown) => void,
  ): PendingItem<unknown> {
    return {
      ...item,
      chatSlots: normalizeChatSlots(item.chatSlots, this.limits.maxConcurrentTasksPerChat),
      resolve: resolve as (value: unknown) => void,
      reject,
      sequence: this.sequence++,
    };
  }

  private drain(): void {
    for (let i = 0; i < this.pending.length; i++) {
      const item = this.pending[i];
      if (!item || !this.canStart(item)) continue;
      this.pending.splice(i, 1);
      i--;
      this.start(item);
    }
  }

  private canStart(item: PendingItem<unknown>): boolean {
    if (this.activeGlobal >= this.limits.maxConcurrentTasks) return false;
    if (item.backgroundWorker && this.backgroundFull()) return false;
    return this.chatCapacityAvailable(item);
  }

  private backgroundFull(): boolean {
    return this.activeBackgroundWorkers >= this.limits.maxBackgroundWorkerTasks;
  }

  private chatCapacityAvailable(item: PendingItem<unknown>): boolean {
    const activeForChat = this.activeByChat.get(chatKey(item)) ?? 0;
    const chatSlots = item.chatSlots ?? 1;
    return activeForChat + chatSlots <= this.limits.maxConcurrentTasksPerChat;
  }

  private start(item: PendingItem<unknown>): void {
    const key = chatKey(item);
    const chatSlots = item.chatSlots ?? 1;
    this.acquire(item, key, chatSlots);
    void item.run()
      .then(item.resolve, item.reject)
      .finally(() => {
        this.release(item, key, chatSlots);
        this.drain();
      });
  }

  private acquire(item: PendingItem<unknown>, key: string, chatSlots: number): void {
    this.activeGlobal++;
    if (item.backgroundWorker) this.activeBackgroundWorkers++;
    this.activeByChat.set(key, (this.activeByChat.get(key) ?? 0) + chatSlots);
  }

  private release(item: PendingItem<unknown>, key: string, chatSlots: number): void {
    this.activeGlobal = Math.max(0, this.activeGlobal - 1);
    if (item.backgroundWorker) {
      this.activeBackgroundWorkers = Math.max(0, this.activeBackgroundWorkers - 1);
    }
    const next = Math.max(0, (this.activeByChat.get(key) ?? 0) - chatSlots);
    if (next === 0) this.activeByChat.delete(key);
    else this.activeByChat.set(key, next);
  }
}

let defaultTaskExecutionQueue = new TaskExecutionQueue(DEFAULT_TASK_EXECUTION_LIMITS);

export function configureDefaultTaskExecutionQueue(limits: TaskExecutionLimits): TaskExecutionQueue {
  defaultTaskExecutionQueue = new TaskExecutionQueue(limits);
  return defaultTaskExecutionQueue;
}

export function getDefaultTaskExecutionQueue(): TaskExecutionQueue {
  return defaultTaskExecutionQueue;
}

function chatKey(item: Pick<TaskExecutionQueueItem<unknown>, 'botName' | 'chatId'>): string {
  return `${item.botName}\\0${item.chatId}`;
}

function validateLimits(limits: TaskExecutionLimits): void {
  for (const [key, value] of Object.entries(limits)) {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(`Invalid task execution limit ${key}: ${value}`);
    }
  }
}

function normalizeChatSlots(value: number | undefined, maxConcurrentTasksPerChat: number): number {
  if (value === undefined) return 1;
  if (!Number.isInteger(value) || value <= 0) return 1;
  return Math.min(value, maxConcurrentTasksPerChat);
}
