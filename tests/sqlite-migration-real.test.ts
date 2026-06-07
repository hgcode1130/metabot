import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { ActivityStore } from '../src/api/activity-store.js';
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

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'metabot-sqlite-migration-'));
}

function tableColumns(dbPath: string, table: string): string[] {
  const db = new Database(dbPath, { readonly: true });
  try {
    return (db.pragma(`table_info(${table})`) as Array<{ name: string }>).map((row) => row.name);
  } finally {
    db.close();
  }
}

describe('real SQLite migrations', () => {
  let tmpDir: string | undefined;
  let originalSessionStoreDir: string | undefined;

  afterEach(() => {
    if (originalSessionStoreDir === undefined) {
      delete process.env.SESSION_STORE_DIR;
    } else {
      process.env.SESSION_STORE_DIR = originalSessionStoreDir;
    }
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('adds structured error columns before ActivityStore creates the error-code index', () => {
    tmpDir = createTempDir();
    originalSessionStoreDir = process.env.SESSION_STORE_DIR;
    process.env.SESSION_STORE_DIR = tmpDir;
    const dbPath = path.join(tmpDir, 'activity.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE activity_events (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL,
        bot_name TEXT NOT NULL,
        chat_id TEXT NOT NULL,
        user_id TEXT,
        prompt TEXT,
        response_preview TEXT,
        cost_usd REAL,
        duration_ms REAL,
        error_message TEXT,
        timestamp INTEGER NOT NULL
      );
    `);
    db.close();

    const store = new ActivityStore(createLogger());
    store.close();

    expect(tableColumns(dbPath, 'activity_events')).toEqual(expect.arrayContaining([
      'error_code',
      'error_kind',
      'retryable',
      'provider_status',
    ]));
  });

  it('adds manager retry/checkpoint columns to an older manager_tasks table', () => {
    tmpDir = createTempDir();
    const dbPath = path.join(tmpDir, 'manager.db');
    const db = new Database(dbPath);
    db.exec(`
      CREATE TABLE manager_tasks (
        id TEXT PRIMARY KEY,
        trace_id TEXT NOT NULL UNIQUE,
        manager_bot_name TEXT NOT NULL,
        manager_chat_id TEXT NOT NULL,
        worker_bot_name TEXT NOT NULL,
        worker_chat_id TEXT NOT NULL,
        label TEXT,
        prompt TEXT NOT NULL,
        status TEXT NOT NULL,
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
    `);
    db.close();

    const store = new ManagerStore(createLogger(), { dbPath });
    store.close();

    expect(tableColumns(dbPath, 'manager_tasks')).toEqual(expect.arrayContaining([
      'attempt_count',
      'max_attempts',
      'next_attempt_at',
      'last_checkpoint_at',
      'last_retry_reason',
    ]));
  });
});
