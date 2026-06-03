import Database from 'better-sqlite3';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Logger } from '../utils/logger.js';

export type ManagerTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export type ManagerTaskEventType =
  | 'created'
  | 'queued'
  | 'started'
  | 'worker_message'
  | 'worker_update'
  | 'prompt_sent'
  | 'completed'
  | 'failed'
  | 'cancel_requested'
  | 'cancelled'
  | 'process_recovered'
  | 'concurrency_waiting'
  | 'manager_notified'
  | 'manager_notification_failed';

export interface ManagerTask {
  id: string;
  traceId: string;
  managerBotName: string;
  managerChatId: string;
  workerBotName: string;
  workerChatId: string;
  label?: string;
  prompt: string;
  status: ManagerTaskStatus;
  createdAt: number;
  updatedAt: number;
  startedAt?: number;
  completedAt?: number;
  costUsd?: number;
  durationMs?: number;
  resultText?: string;
  error?: string;
  metadata?: Record<string, unknown>;
}

export interface ManagerTaskEvent {
  id: string;
  taskId: string;
  type: ManagerTaskEventType;
  payload?: Record<string, unknown>;
  createdAt: number;
}

export interface CreateManagerTaskInput {
  traceId?: string;
  managerBotName: string;
  managerChatId: string;
  workerBotName: string;
  workerChatId: string;
  label?: string;
  prompt: string;
  metadata?: Record<string, unknown>;
}

export interface ManagerTaskListFilter {
  managerBotName?: string;
  managerChatId?: string;
  workerBotName?: string;
  status?: ManagerTaskStatus;
  limit?: number;
}

export type ManagerTaskPatch = Partial<Pick<
  ManagerTask,
  'status' | 'startedAt' | 'completedAt' | 'costUsd' | 'durationMs' | 'resultText' | 'error' | 'metadata'
>>;

type TaskRow = {
  id: string;
  trace_id: string;
  manager_bot_name: string;
  manager_chat_id: string;
  worker_bot_name: string;
  worker_chat_id: string;
  label: string | null;
  prompt: string;
  status: ManagerTaskStatus;
  created_at: number;
  updated_at: number;
  started_at: number | null;
  completed_at: number | null;
  cost_usd: number | null;
  duration_ms: number | null;
  result_text: string | null;
  error: string | null;
  metadata_json: string | null;
};

type EventRow = {
  id: string;
  task_id: string;
  type: ManagerTaskEventType;
  payload_json: string | null;
  created_at: number;
};

export interface ManagerStoreOptions {
  dbPath?: string;
}

export class ManagerStore {
  private db: Database.Database;
  private logger: Logger;

  constructor(logger: Logger, options: ManagerStoreOptions = {}) {
    this.logger = logger.child({ module: 'manager-store' });
    const dbPath = options.dbPath ?? defaultDbPath();
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma('journal_mode = WAL');
    this.migrate();
    this.logger.info({ dbPath }, 'Manager database initialized');
  }

  createTask(input: CreateManagerTaskInput): ManagerTask {
    const now = Date.now();
    const task: ManagerTask = {
      id: `mgrtask-${crypto.randomUUID()}`,
      traceId: input.traceId ?? `trace-${crypto.randomUUID()}`,
      managerBotName: input.managerBotName,
      managerChatId: input.managerChatId,
      workerBotName: input.workerBotName,
      workerChatId: input.workerChatId,
      label: input.label,
      prompt: input.prompt,
      status: 'queued',
      createdAt: now,
      updatedAt: now,
      metadata: input.metadata,
    };

    const insert = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO manager_tasks (
          id, trace_id, manager_bot_name, manager_chat_id, worker_bot_name, worker_chat_id,
          label, prompt, status, created_at, updated_at, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        task.id,
        task.traceId,
        task.managerBotName,
        task.managerChatId,
        task.workerBotName,
        task.workerChatId,
        task.label ?? null,
        task.prompt,
        task.status,
        task.createdAt,
        task.updatedAt,
        task.metadata ? JSON.stringify(task.metadata) : null,
      );
      this.insertEvent(task.id, 'created', { traceId: task.traceId });
    });
    insert();

    return task;
  }

  getTask(id: string): ManagerTask | undefined {
    const row = this.db.prepare('SELECT * FROM manager_tasks WHERE id = ?').get(id) as TaskRow | undefined;
    return row ? this.rowToTask(row) : undefined;
  }

  listTasks(filter: ManagerTaskListFilter = {}): ManagerTask[] {
    let sql = 'SELECT * FROM manager_tasks WHERE 1=1';
    const params: Array<string | number> = [];

    if (filter.managerBotName) {
      sql += ' AND manager_bot_name = ?';
      params.push(filter.managerBotName);
    }
    if (filter.managerChatId) {
      sql += ' AND manager_chat_id = ?';
      params.push(filter.managerChatId);
    }
    if (filter.workerBotName) {
      sql += ' AND worker_bot_name = ?';
      params.push(filter.workerBotName);
    }
    if (filter.status) {
      sql += ' AND status = ?';
      params.push(filter.status);
    }

    sql += ' ORDER BY created_at DESC LIMIT ?';
    params.push(Math.min(Math.max(Math.floor(filter.limit ?? 50), 1), 500));

    const rows = this.db.prepare(sql).all(...params) as TaskRow[];
    return rows.map((row) => this.rowToTask(row));
  }

  updateTask(id: string, patch: ManagerTaskPatch): ManagerTask | undefined {
    const existing = this.getTask(id);
    if (!existing) return undefined;

    const updates: string[] = ['updated_at = ?'];
    const params: Array<string | number | null> = [Date.now()];

    if (patch.status !== undefined) {
      updates.push('status = ?');
      params.push(patch.status);
    }
    if (patch.startedAt !== undefined) {
      updates.push('started_at = ?');
      params.push(patch.startedAt);
    }
    if (patch.completedAt !== undefined) {
      updates.push('completed_at = ?');
      params.push(patch.completedAt);
    }
    if (patch.costUsd !== undefined) {
      updates.push('cost_usd = ?');
      params.push(patch.costUsd);
    }
    if (patch.durationMs !== undefined) {
      updates.push('duration_ms = ?');
      params.push(patch.durationMs);
    }
    if (patch.resultText !== undefined) {
      updates.push('result_text = ?');
      params.push(patch.resultText);
    }
    if (patch.error !== undefined) {
      updates.push('error = ?');
      params.push(patch.error);
    }
    if (patch.metadata !== undefined) {
      updates.push('metadata_json = ?');
      params.push(JSON.stringify(patch.metadata));
    }

    params.push(id);
    this.db.prepare(`UPDATE manager_tasks SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    return this.getTask(id);
  }

  appendEvent(taskId: string, type: ManagerTaskEventType, payload?: Record<string, unknown>): ManagerTaskEvent {
    return this.insertEvent(taskId, type, payload);
  }

  listEvents(taskId: string): ManagerTaskEvent[] {
    const rows = this.db
      .prepare('SELECT * FROM manager_task_events WHERE task_id = ? ORDER BY created_at ASC, rowid ASC')
      .all(taskId) as EventRow[];
    return rows.map((row) => this.rowToEvent(row));
  }

  markInterruptedTasksFailed(reason: string): number {
    const tasks = this.listInterruptedTasks();
    if (tasks.length === 0) return 0;

    const mark = this.db.transaction(() => {
      const now = Date.now();
      const update = this.db.prepare(`
        UPDATE manager_tasks
        SET status = 'failed', updated_at = ?, completed_at = ?, error = ?
        WHERE id = ? AND status IN ('queued', 'running')
      `);
      for (const task of tasks) {
        update.run(now, now, reason, task.id);
        this.insertEvent(task.id, 'process_recovered', { reason });
        this.insertEvent(task.id, 'failed', { reason });
      }
    });
    mark();
    return tasks.length;
  }

  close(): void {
    this.db.close();
  }

  private migrate(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS manager_tasks (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL UNIQUE,
        manager_bot_name TEXT NOT NULL,
        manager_chat_id TEXT NOT NULL,
        worker_bot_name TEXT NOT NULL,
        worker_chat_id TEXT NOT NULL,
        label TEXT,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'completed', 'failed', 'cancelled')),
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        started_at INTEGER,
        completed_at INTEGER,
        cost_usd REAL,
        duration_ms INTEGER,
        result_text TEXT,
        error TEXT,
        metadata_json TEXT
      );

      CREATE TABLE IF NOT EXISTS manager_task_events (
        id TEXT PRIMARY KEY,
        task_id TEXT NOT NULL,
        type TEXT NOT NULL,
        payload_json TEXT,
        created_at INTEGER NOT NULL,
        FOREIGN KEY (task_id) REFERENCES manager_tasks(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_manager_tasks_manager_scope
        ON manager_tasks(manager_bot_name, manager_chat_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_manager_tasks_worker
        ON manager_tasks(worker_bot_name, worker_chat_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_manager_tasks_status
        ON manager_tasks(status, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_manager_events_task
        ON manager_task_events(task_id, created_at ASC);
    `);
  }

  private listInterruptedTasks(): ManagerTask[] {
    const rows = this.db
      .prepare("SELECT * FROM manager_tasks WHERE status IN ('queued', 'running') ORDER BY created_at ASC")
      .all() as TaskRow[];
    return rows.map((row) => this.rowToTask(row));
  }

  private insertEvent(taskId: string, type: ManagerTaskEventType, payload?: Record<string, unknown>): ManagerTaskEvent {
    const event: ManagerTaskEvent = {
      id: `mgrevt-${crypto.randomUUID()}`,
      taskId,
      type,
      payload,
      createdAt: Date.now(),
    };
    this.db.prepare(`
      INSERT INTO manager_task_events (id, task_id, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.taskId,
      event.type,
      event.payload ? JSON.stringify(event.payload) : null,
      event.createdAt,
    );
    return event;
  }

  private rowToTask(row: TaskRow): ManagerTask {
    return {
      id: row.id,
      traceId: row.trace_id,
      managerBotName: row.manager_bot_name,
      managerChatId: row.manager_chat_id,
      workerBotName: row.worker_bot_name,
      workerChatId: row.worker_chat_id,
      label: row.label ?? undefined,
      prompt: row.prompt,
      status: row.status,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      startedAt: row.started_at ?? undefined,
      completedAt: row.completed_at ?? undefined,
      costUsd: row.cost_usd ?? undefined,
      durationMs: row.duration_ms ?? undefined,
      resultText: row.result_text ?? undefined,
      error: row.error ?? undefined,
      metadata: parseJsonObject(row.metadata_json),
    };
  }

  private rowToEvent(row: EventRow): ManagerTaskEvent {
    return {
      id: row.id,
      taskId: row.task_id,
      type: row.type,
      payload: parseJsonObject(row.payload_json),
      createdAt: row.created_at,
    };
  }
}

function defaultDbPath(): string {
  return path.join(os.homedir(), '.metabot', 'manager.db');
}

function parseJsonObject(value: string | null): Record<string, unknown> | undefined {
  if (!value) return undefined;
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : undefined;
  } catch {
    return undefined;
  }
}
