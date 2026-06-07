import { describe, it, expect } from 'vitest';
import { CommandHandler, type RestartServiceInput } from '../src/bridge/command-handler.js';
import type { IncomingMessage } from '../src/types.js';

interface RecordedNotice {
  chatId: string;
  title: string;
  content: string;
  color?: string;
}

function restartMessage(): IncomingMessage {
  return {
    messageId: 'm1',
    chatId: 'c1',
    chatType: 'p2p',
    userId: 'u1',
    text: '/restart',
    timestamp: Date.now(),
    isBotMentioned: true,
  } as IncomingMessage;
}

function buildHandler(restartService: (input: RestartServiceInput) => Promise<void>) {
  const notices: RecordedNotice[] = [];
  const auditEvents: unknown[] = [];
  const sender = {
    sendCard: async () => undefined,
    updateCard: async () => true,
    sendTextNotice: async (chatId: string, title: string, content: string, color?: string) => {
      notices.push({ chatId, title, content, color });
    },
    sendText: async () => {},
    sendImageFile: async () => true,
    sendLocalFile: async () => true,
    downloadImage: async () => true,
    downloadFile: async () => true,
  };

  const handler = new CommandHandler({
    config: { name: 'test-bot' } as any,
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} } as any,
    sender: sender as any,
    sessionManager: {} as any,
    memoryClient: {} as any,
    audit: { log: (event: unknown) => { auditEvents.push(event); } } as any,
    hooks: {
      getRunningTask: () => undefined,
      stopTask: () => {},
      clearQueue: () => 0,
      releaseExecutor: async () => {},
      restartService,
    },
  });
  return { handler, notices, auditEvents };
}

describe('CommandHandler /restart', () => {
  it('sends a notice and invokes restartService with traceable context', async () => {
    let restartInput: RestartServiceInput | undefined;
    const { handler, notices, auditEvents } = buildHandler(async (input) => {
      restartInput = input;
    });

    const handled = await handler.handle(restartMessage());

    expect(handled).toBe(true);
    expect(notices).toHaveLength(1);
    expect(notices[0].title).toContain('Restarting');
    expect(notices[0].color).toBe('orange');
    expect(restartInput).toEqual({ chatId: 'c1', userId: 'u1', reason: '/restart command' });
    expect(auditEvents).toContainEqual(expect.objectContaining({ event: 'service_restart_requested' }));
  });

  it('surfaces restartService failures to the user', async () => {
    const { handler, notices } = buildHandler(async () => {
      throw new Error('restart script not found');
    });

    const handled = await handler.handle(restartMessage());

    expect(handled).toBe(true);
    expect(notices).toHaveLength(2);
    expect(notices[0].title).toContain('Restarting');
    expect(notices[1]).toEqual(expect.objectContaining({
      title: '❌ Restart Failed',
      content: 'restart script not found',
      color: 'red',
    }));
  });
});
