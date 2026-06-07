import { afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

vi.mock('better-sqlite3', async () => {
  const mod = await import('./__mocks__/better-sqlite3.js');
  return { default: mod.default };
});

import { ActivityStore } from '../src/api/activity-store.js';
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

describe('ActivityStore', () => {
  let tmpDir: string | undefined;
  const originalSessionStoreDir = process.env.SESSION_STORE_DIR;

  afterEach(() => {
    process.env.SESSION_STORE_DIR = originalSessionStoreDir;
    if (tmpDir) {
      fs.rmSync(tmpDir, { recursive: true, force: true });
      tmpDir = undefined;
    }
  });

  it('persists structured task error metadata', () => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'activity-store-test-'));
    process.env.SESSION_STORE_DIR = tmpDir;
    const store = new ActivityStore(createLogger());

    store.record({
      type: 'task_failed',
      botName: 'manager',
      chatId: 'chat-a',
      errorMessage: 'API Error: 524 origin_response_timeout',
      errorCode: 'gateway_timeout_524',
      errorKind: 'gateway_timeout',
      retryable: true,
      providerStatus: 524,
      timestamp: Date.now(),
    });

    expect(store.list({ limit: 1 })[0]).toMatchObject({
      errorCode: 'gateway_timeout_524',
      errorKind: 'gateway_timeout',
      retryable: true,
      providerStatus: 524,
    });
    store.close();
  });
});
