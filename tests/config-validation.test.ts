import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { validateBotsConfig } from '../src/config-validation.js';
import { loadAppConfig } from '../src/config.js';
import { updateBot } from '../src/api/bots-config-writer.js';

const originalEnv = { ...process.env };

function restoreEnv() {
  process.env = { ...originalEnv };
}

function minimalFeishuBot(name = 'manager') {
  return {
    name,
    feishuAppId: 'cli_example',
    feishuAppSecret: 'secret_example',
    defaultWorkingDirectory: '/tmp/metabot',
  };
}

function minimalWebBot(name = 'worker') {
  return {
    name,
    defaultWorkingDirectory: '/tmp/metabot-worker',
  };
}

describe('validateBotsConfig', () => {
  afterEach(() => {
    restoreEnv();
    vi.restoreAllMocks();
  });

  it('accepts the legacy Feishu bot array format', () => {
    expect(() => validateBotsConfig([minimalFeishuBot()], 'legacy')).not.toThrow();
  });

  it('accepts the current object format with manager and persistent executor settings', () => {
    expect(() => validateBotsConfig({
      taskExecution: {
        maxConcurrentTasks: 10,
        maxConcurrentTasksPerChat: 2,
        maxBackgroundWorkerTasks: 4,
      },
      feishuBots: [{
        ...minimalFeishuBot(),
        manager: {
          enabled: true,
          workers: ['worker-code'],
          maxConcurrentWorkerTasks: 2,
        },
        persistentExecutor: {
          enabled: true,
          idleTimeoutMs: 3600000,
          maxConcurrent: 4,
        },
      }],
      webBots: [minimalWebBot('worker-code')],
      peers: [{ name: 'peer-a', url: 'http://localhost:9100' }],
    }, 'bots.json')).not.toThrow();
  });

  it('rejects invalid task execution limits', () => {
    expect(() => validateBotsConfig({
      taskExecution: { maxConcurrentTasks: 0 },
      feishuBots: [minimalFeishuBot()],
    }, 'bots.json')).toThrow(/maxConcurrentTasks/);
  });

  it('rejects invalid manager concurrency values', () => {
    expect(() => validateBotsConfig({
      feishuBots: [{
        ...minimalFeishuBot(),
        manager: { enabled: true, maxConcurrentWorkerTasks: 0 },
      }],
    }, 'bots.json')).toThrow(/maxConcurrentWorkerTasks/);
  });

  it('rejects duplicate bot names across platforms', () => {
    expect(() => validateBotsConfig({
      feishuBots: [minimalFeishuBot('same')],
      webBots: [minimalWebBot('same')],
    }, 'bots.json')).toThrow(/duplicate bot name: same/);
  });

  it('copies persistentExecutor from bots.json into runtime config', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-config-'));
    const configPath = join(dir, 'bots.json');
    const priorBotsConfig = process.env.BOTS_CONFIG;
    try {
      writeFileSync(configPath, JSON.stringify({
        webBots: [{
          ...minimalWebBot('worker-code'),
          persistentExecutor: {
            enabled: false,
            idleTimeoutMs: 1234,
            maxConcurrent: 3,
          },
        }],
      }));
      process.env.BOTS_CONFIG = configPath;
      const appConfig = loadAppConfig();
      expect(appConfig.webBots[0].persistentExecutor).toEqual({
        enabled: false,
        idleTimeoutMs: 1234,
        maxConcurrent: 3,
      });
    } finally {
      if (priorBotsConfig === undefined) delete process.env.BOTS_CONFIG;
      else process.env.BOTS_CONFIG = priorBotsConfig;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('loads task execution defaults and env overrides', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-task-execution-'));
    const configPath = join(dir, 'bots.json');
    try {
      writeFileSync(configPath, JSON.stringify({ webBots: [minimalWebBot('worker-code')] }));
      process.env.BOTS_CONFIG = configPath;
      process.env.METABOT_MAX_CONCURRENT_TASKS = '9';
      process.env.METABOT_MAX_CONCURRENT_TASKS_PER_CHAT = '2';
      process.env.METABOT_MAX_BACKGROUND_WORKER_TASKS = '3';
      expect(loadAppConfig().taskExecution).toEqual({
        maxConcurrentTasks: 9,
        maxConcurrentTasksPerChat: 2,
        maxBackgroundWorkerTasks: 3,
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects invalid config updates before writing', () => {
    const dir = mkdtempSync(join(tmpdir(), 'metabot-config-writer-'));
    const configPath = join(dir, 'bots.json');
    try {
      writeFileSync(configPath, JSON.stringify({ webBots: [minimalWebBot('worker-code')] }));
      expect(() => updateBot(configPath, 'worker-code', {
        manager: { enabled: true, maxConcurrentWorkerTasks: -1 },
      })).toThrow(/maxConcurrentWorkerTasks/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
