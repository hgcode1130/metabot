import Database from 'better-sqlite3';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Logger } from '../utils/logger.js';
import { ensurePrivateFileMode } from '../utils/file-permissions.js';

export type ManagerTaskStatus = 'queued' | 'running' | 'completed' | 'failed' | 'cancelled';

export const MANAGER_TASK_EVENT_TYPES = [
  'created',
  'instruction_contract',
  'delegation_budget',
  'trace_policy',
  'queued',
  'started',
  'worker_message',
  'worker_update',
  'action_gate_blocked',
  'worker_result',
  'worker_result_invalid',
  'acceptance_report',
  'artifact_registered',
  'prompt_sent',
  'prompt_queued_as_task',
  'completed',
  'failed',
  'checkpoint',
  'retry_scheduled',
  'retry_started',
  'retry_paused',
  'retry_exhausted',
  'resume_queued',
  'resumed',
  'cancel_requested',
  'cancel_confirmed',
  'cancel_failed_to_stop',
  'cancelled',
  'process_recovered',
  'concurrency_waiting',
  'manager_notified',
  'manager_notification_failed',
] as const;

export type ManagerTaskEventType = (typeof MANAGER_TASK_EVENT_TYPES)[number];

export type ManagerTaskEventPayloadMode = 'full' | 'preview';

export interface ManagerTaskEventListOptions {
  limit?: number;
  type?: ManagerTaskEventType;
  payload?: ManagerTaskEventPayloadMode;
}

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
  attemptCount: number;
  maxAttempts: number;
  nextAttemptAt?: number;
  lastCheckpointAt?: number;
  lastRetryReason?: string;
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

export interface RecoverInterruptedTasksResult {
  requeued: ManagerTask[];
  exhausted: ManagerTask[];
  paused: ManagerTask[];
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
  | 'status'
  | 'startedAt'
  | 'completedAt'
  | 'costUsd'
  | 'durationMs'
  | 'resultText'
  | 'error'
  | 'attemptCount'
  | 'maxAttempts'
  | 'nextAttemptAt'
  | 'lastCheckpointAt'
  | 'lastRetryReason'
  | 'metadata'
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
  attempt_count?: number | null;
  max_attempts?: number | null;
  next_attempt_at?: number | null;
  last_checkpoint_at?: number | null;
  last_retry_reason?: string | null;
  metadata_json: string | null;
};

type EventRow = {
  id: string;
  task_id: string;
  type: ManagerTaskEventType;
  payload_json: string | null;
  created_at: number;
};

const DEFAULT_EVENT_LIMIT = 200;
const MAX_EVENT_LIMIT = 1000;
const EVENT_PAYLOAD_PREVIEW_CHARS = 2000;
const DEFAULT_INLINE_EVENT_PAYLOAD_BYTES = 16 * 1024;
const EVENT_PAYLOAD_ARCHIVE_DIR = 'manager-event-payloads';
const EVENT_PAYLOAD_ARCHIVE_VERSION = 1;

export interface ManagerStoreOptions {
  dbPath?: string;
  eventPayloadArchiveDir?: string;
  maxInlineEventPayloadBytes?: number;
}

export class ManagerStore {
  private db: Database.Database;
  private logger: Logger;
  private dbPath: string;
  private eventPayloadArchiveDir: string;
  private maxInlineEventPayloadBytes: number;

  constructor(logger: Logger, options: ManagerStoreOptions = {}) {
    this.logger = logger.child({ module: 'manager-store' });
    const dbPath = options.dbPath ?? defaultDbPath();
    this.dbPath = dbPath;
    this.eventPayloadArchiveDir = options.eventPayloadArchiveDir
      ?? path.join(path.dirname(dbPath), EVENT_PAYLOAD_ARCHIVE_DIR);
    this.maxInlineEventPayloadBytes = options.maxInlineEventPayloadBytes
      ?? DEFAULT_INLINE_EVENT_PAYLOAD_BYTES;
    fs.mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    ensurePrivateFileMode(dbPath);
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
      attemptCount: 0,
      maxAttempts: 5,
      metadata: input.metadata,
    };

    const insert = this.db.transaction(() => {
      this.db.prepare(`
        INSERT INTO manager_tasks (
          id, trace_id, manager_bot_name, manager_chat_id, worker_bot_name, worker_chat_id,
          label, prompt, status, created_at, updated_at, attempt_count, max_attempts, metadata_json
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
        task.attemptCount,
        task.maxAttempts,
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
    if (patch.attemptCount !== undefined) {
      updates.push('attempt_count = ?');
      params.push(patch.attemptCount);
    }
    if (patch.maxAttempts !== undefined) {
      updates.push('max_attempts = ?');
      params.push(patch.maxAttempts);
    }
    if (patch.nextAttemptAt !== undefined) {
      updates.push('next_attempt_at = ?');
      params.push(patch.nextAttemptAt);
    }
    if (patch.lastCheckpointAt !== undefined) {
      updates.push('last_checkpoint_at = ?');
      params.push(patch.lastCheckpointAt);
    }
    if (patch.lastRetryReason !== undefined) {
      updates.push('last_retry_reason = ?');
      params.push(patch.lastRetryReason);
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

  listEvents(taskId: string, options: ManagerTaskEventListOptions = {}): ManagerTaskEvent[] {
    let sql = 'SELECT rowid, * FROM manager_task_events WHERE task_id = ?';
    const params: Array<string | number> = [taskId];
    if (options.type) {
      sql += ' AND type = ?';
      params.push(options.type);
    }
    sql += ' ORDER BY created_at DESC, rowid DESC LIMIT ?';
    params.push(normalizeEventLimit(options.limit));

    const rows = this.db
      .prepare(`SELECT * FROM (${sql}) ORDER BY created_at ASC, rowid ASC`)
      .all(...params) as EventRow[];
    return rows.map((row) => this.rowToEvent(row, options.payload ?? 'full'));
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

  recoverInterruptedTasks(reason: string): RecoverInterruptedTasksResult {
    const tasks = this.listInterruptedTasks();
    if (tasks.length === 0) return { requeued: [], exhausted: [], paused: [] };

    const requeued: ManagerTask[] = [];
    const exhausted: ManagerTask[] = [];
    const paused: ManagerTask[] = [];
    const recover = this.db.transaction(() => {
      for (const task of tasks) {
        if (task.attemptCount >= task.maxAttempts) {
          this.markTaskRetryExhausted(task, reason);
          exhausted.push(this.getTask(task.id) ?? task);
        } else if (canAutoRecoverTask(task)) {
          this.requeueRecoveredTask(task, reason);
          requeued.push(this.getTask(task.id) ?? task);
        } else {
          this.pauseRecoveredTask(task, reason);
          paused.push(this.getTask(task.id) ?? task);
        }
      }
    });
    recover();
    return { requeued, exhausted, paused };
  }

  close(): void {
    this.db.close();
  }

  diagnostics(): { dbPath: string } {
    return { dbPath: this.dbPath };
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
        attempt_count INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 5,
        next_attempt_at INTEGER,
        last_checkpoint_at INTEGER,
        last_retry_reason TEXT,
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
    this.addMissingTaskColumns();
  }

  private addMissingTaskColumns(): void {
    const columns = new Set(
      this.tableColumns('manager_tasks'),
    );
    const specs = [
      ['attempt_count', 'INTEGER NOT NULL DEFAULT 0'],
      ['max_attempts', 'INTEGER NOT NULL DEFAULT 5'],
      ['next_attempt_at', 'INTEGER'],
      ['last_checkpoint_at', 'INTEGER'],
      ['last_retry_reason', 'TEXT'],
    ];
    for (const [name, spec] of specs) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE manager_tasks ADD COLUMN ${name} ${spec}`);
    }
  }

  private tableColumns(table: string): string[] {
    const result = this.db.pragma(`table_info(${table})`) as unknown;
    if (!Array.isArray(result)) return [];
    return result
      .map((row) => (row as { name?: unknown }).name)
      .filter((name): name is string => typeof name === 'string');
  }

  private markTaskRetryExhausted(task: ManagerTask, reason: string): void {
    const now = Date.now();
    this.db.prepare(`
      UPDATE manager_tasks
      SET status = 'failed', updated_at = ?, completed_at = ?, error = ?, last_retry_reason = ?
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(now, now, reason, reason, task.id);
    this.insertEvent(task.id, 'process_recovered', { reason });
    this.insertEvent(task.id, 'retry_exhausted', { reason });
    this.insertEvent(task.id, 'failed', { reason });
  }

  private requeueRecoveredTask(task: ManagerTask, reason: string): void {
    const now = Date.now();
    const nextAttemptAt = task.nextAttemptAt && task.nextAttemptAt > now ? task.nextAttemptAt : now;
    this.updateTask(task.id, {
      status: 'queued',
      nextAttemptAt,
      lastRetryReason: reason,
      metadata: recoveryMetadata(task, reason, 'auto_resumed'),
    });
    this.insertEvent(task.id, 'process_recovered', { reason });
    this.insertEvent(task.id, 'resume_queued', { reason });
  }

  private pauseRecoveredTask(task: ManagerTask, reason: string): void {
    this.updateTask(task.id, {
      status: 'failed',
      completedAt: Date.now(),
      error: 'Recovery paused: side-effect safety requires manager review',
      lastRetryReason: reason,
      metadata: recoveryMetadata(task, reason, 'needs_resume_review'),
    });
    const sideEffectClass = readSideEffectClass(task.metadata);
    this.insertEvent(task.id, 'process_recovered', { reason });
    this.insertEvent(task.id, 'retry_paused', { reason, sideEffectClass });
    this.insertEvent(task.id, 'failed', { reason, sideEffectClass });
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
    const payloadJson = this.storedEventPayloadJson(event, payload);
    this.db.prepare(`
      INSERT INTO manager_task_events (id, task_id, type, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?)
    `).run(
      event.id,
      event.taskId,
      event.type,
      payloadJson,
      event.createdAt,
    );
    return event;
  }

  private storedEventPayloadJson(
    event: Pick<ManagerTaskEvent, 'id' | 'taskId'>,
    payload?: Record<string, unknown>,
  ): string | null {
    if (!payload) return null;
    const serialized = JSON.stringify(payload);
    if (Buffer.byteLength(serialized, 'utf8') <= this.maxInlineEventPayloadBytes) return serialized;
    const archiveRef = this.writeEventPayloadArchive(event, serialized);
    return JSON.stringify(archivedPayloadSummary(serialized, archiveRef));
  }

  private writeEventPayloadArchive(event: Pick<ManagerTaskEvent, 'id' | 'taskId'>, serialized: string): string {
    const dir = path.join(this.eventPayloadArchiveDir, safePathPart(event.taskId));
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${safePathPart(event.id)}.json`);
    fs.writeFileSync(filePath, serialized, { encoding: 'utf8', mode: 0o600 });
    ensurePrivateFileMode(filePath);
    return path.relative(this.eventPayloadArchiveDir, filePath);
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
      attemptCount: row.attempt_count ?? 0,
      maxAttempts: row.max_attempts ?? 5,
      nextAttemptAt: row.next_attempt_at ?? undefined,
      lastCheckpointAt: row.last_checkpoint_at ?? undefined,
      lastRetryReason: row.last_retry_reason ?? undefined,
      metadata: parseJsonObject(row.metadata_json),
    };
  }

  private rowToEvent(row: EventRow, payloadMode: ManagerTaskEventPayloadMode): ManagerTaskEvent {
    return {
      id: row.id,
      taskId: row.task_id,
      type: row.type,
      payload: eventPayload(row.payload_json, payloadMode, this.eventPayloadArchiveDir),
      createdAt: row.created_at,
    };
  }
}

function normalizeEventLimit(limit: number | undefined): number {
  if (limit === undefined) return DEFAULT_EVENT_LIMIT;
  return Math.min(Math.max(Math.floor(limit), 1), MAX_EVENT_LIMIT);
}

function eventPayload(
  value: string | null,
  mode: ManagerTaskEventPayloadMode,
  archiveDir: string,
): Record<string, unknown> | undefined {
  const parsed = parseJsonObject(value);
  if (!parsed) return undefined;
  if (mode === 'full') return fullEventPayload(parsed, archiveDir);
  if (isArchivedPayloadSummary(parsed)) return parsed;
  const serialized = JSON.stringify(parsed);
  if (serialized.length <= EVENT_PAYLOAD_PREVIEW_CHARS) return parsed;
  return {
    preview: serialized.slice(0, EVENT_PAYLOAD_PREVIEW_CHARS),
    truncated: true,
    originalLength: serialized.length,
  };
}

function fullEventPayload(payload: Record<string, unknown>, archiveDir: string): Record<string, unknown> {
  if (!isArchivedPayloadSummary(payload)) return payload;
  const archivePath = path.join(archiveDir, payload.archiveRef);
  const archived = fs.readFileSync(archivePath, 'utf8');
  return parseJsonObject(archived) ?? failInvalidArchivedPayload(archivePath);
}

function archivedPayloadSummary(serialized: string, archiveRef: string): Record<string, unknown> {
  return {
    payloadArchiveVersion: EVENT_PAYLOAD_ARCHIVE_VERSION,
    payloadArchived: true,
    archiveRef,
    sha256: crypto.createHash('sha256').update(serialized).digest('hex'),
    originalLength: serialized.length,
    originalBytes: Buffer.byteLength(serialized, 'utf8'),
    preview: serialized.slice(0, EVENT_PAYLOAD_PREVIEW_CHARS),
  };
}

function isArchivedPayloadSummary(payload: Record<string, unknown>): payload is Record<string, unknown> & { archiveRef: string } {
  return payload.payloadArchived === true && typeof payload.archiveRef === 'string';
}

function failInvalidArchivedPayload(archivePath: string): never {
  throw new Error(`Invalid archived manager event payload: ${archivePath}`);
}

function safePathPart(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function defaultDbPath(): string {
  return path.join(os.homedir(), '.metabot', 'manager.db');
}

function canAutoRecoverTask(task: Pick<ManagerTask, 'metadata'>): boolean {
  const sideEffectClass = readSideEffectClass(task.metadata);
  return sideEffectClass === 'none' || sideEffectClass === 'readOnly';
}

function recoveryMetadata(
  task: Pick<ManagerTask, 'metadata'>,
  reason: string,
  recoveryStatus: 'auto_resumed' | 'needs_resume_review',
): Record<string, unknown> {
  return {
    ...(task.metadata ?? {}),
    retryResume: recoveryStatus === 'auto_resumed',
    recoveryStatus,
    recoveryReason: reason,
    sideEffectClass: readSideEffectClass(task.metadata),
  };
}

function readSideEffectClass(metadata: Record<string, unknown> | undefined): string {
  const value = metadata?.sideEffectClass;
  if (value === 'none' || value === 'readOnly' || value === 'localWrite' || value === 'externalWrite') return value;
  return 'unknown';
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
