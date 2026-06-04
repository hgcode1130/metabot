import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BotConfigBase } from '../src/config.js';
import type { IMessageSender } from '../src/bridge/message-sender.interface.js';
import { MessageBridge } from '../src/bridge/message-bridge.js';
import { RateLimiter } from '../src/bridge/rate-limiter.js';
import { StreamProcessor } from '../src/engines/index.js';

function createLogger() {
  return {
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
    child: vi.fn(),
  } as any;
}

function createConfig(): BotConfigBase {
  return {
    name: 'shutdown-test',
    engine: 'codex',
    claude: {
      defaultWorkingDirectory: '/tmp/metabot-shutdown-test',
      maxTurns: undefined,
      maxBudgetUsd: undefined,
      model: undefined,
      apiKey: undefined,
      outputsBaseDir: '/tmp/metabot-shutdown-test/outputs',
      downloadsDir: '/tmp/metabot-shutdown-test/downloads',
    },
  };
}

function createSender() {
  return {
    sendCard: vi.fn(),
    updateCard: vi.fn().mockResolvedValue(true),
    updateQuestionCard: vi.fn().mockResolvedValue(true),
    sendTextNotice: vi.fn(),
    sendText: vi.fn(),
    sendImageFile: vi.fn(),
    sendLocalFile: vi.fn(),
    downloadImage: vi.fn(),
    downloadFile: vi.fn(),
  } satisfies IMessageSender;
}

function createExecutionHandle() {
  return {
    stream: (async function* () {})(),
    sendAnswer: vi.fn(),
    resolveQuestion: vi.fn(),
    finish: vi.fn(),
  };
}

describe('MessageBridge shutdown', () => {
  let storeDir: string;

  beforeEach(() => {
    storeDir = mkdtempSync(join(tmpdir(), 'metabot-bridge-shutdown-'));
    process.env.SESSION_STORE_DIR = storeDir;
  });

  afterEach(() => {
    delete process.env.SESSION_STORE_DIR;
    rmSync(storeDir, { recursive: true, force: true });
  });

  it('marks a running task card as interrupted before clearing local state', async () => {
    const sender = createSender();
    const bridge = new MessageBridge(
      createConfig(),
      createLogger(),
      sender,
      'http://127.0.0.1:0',
    ) as any;
    const abortController = new AbortController();
    const executionHandle = createExecutionHandle();

    bridge.runningTasks.set('oc_test', {
      abortController,
      startTime: Date.now(),
      executionHandle,
      pendingQuestion: null,
      currentQuestionIndex: 0,
      collectedAnswers: {},
      cardMessageId: 'msg_running',
      questionCardMessageId: 'msg_question',
      processor: new StreamProcessor('完成我们的plan'),
      rateLimiter: new RateLimiter(0),
      chatId: 'oc_test',
      teamState: {
        teammates: [],
        tasks: [{ taskId: '1', subject: 'Create clean remote project', status: 'in_progress' }],
      },
    });

    await bridge.destroy();

    expect(sender.updateCard).toHaveBeenCalledWith(
      'msg_running',
      expect.objectContaining({
        status: 'error',
        userPrompt: '完成我们的plan',
        teamState: expect.objectContaining({
          tasks: [expect.objectContaining({ status: 'in_progress' })],
        }),
        errorMessage: 'Task was interrupted because MetaBot restarted.',
      }),
    );
    expect(sender.updateQuestionCard).toHaveBeenCalledWith(
      'msg_question',
      expect.objectContaining({
        status: 'error',
        responseText: '_Question canceled because MetaBot restarted._',
      }),
    );
    expect(executionHandle.finish).toHaveBeenCalledOnce();
    expect(abortController.signal.aborted).toBe(true);
    expect(bridge.runningTasks.size).toBe(0);
  });

  it('marks continuation cards as interrupted during shutdown', async () => {
    const sender = createSender();
    const bridge = new MessageBridge(
      createConfig(),
      createLogger(),
      sender,
      'http://127.0.0.1:0',
    ) as any;
    const abortController = new AbortController();

    bridge.continuationTasks.set('oc_test', {
      abortController,
      cardMessageId: 'msg_continuation',
      turnId: 'turn_1',
    });

    await bridge.destroy();

    expect(sender.updateCard).toHaveBeenCalledWith(
      'msg_continuation',
      expect.objectContaining({
        status: 'error',
        errorMessage: 'Agent continuation was interrupted because MetaBot restarted.',
      }),
    );
    expect(abortController.signal.aborted).toBe(true);
    expect(bridge.continuationTasks.size).toBe(0);
  });

  it('logs failed shutdown card updates instead of treating false as success', async () => {
    const sender = createSender();
    sender.updateCard.mockResolvedValue(false);
    const logger = createLogger();
    const bridge = new MessageBridge(
      createConfig(),
      logger,
      sender,
      'http://127.0.0.1:0',
    ) as any;

    bridge.continuationTasks.set('oc_test', {
      abortController: new AbortController(),
      cardMessageId: 'msg_continuation',
      turnId: 'turn_1',
    });

    await bridge.destroy();

    expect(logger.warn).toHaveBeenCalledWith(
      { failedFinalizers: 1 },
      'Failed to finalize some cards during shutdown',
    );
  });
});
