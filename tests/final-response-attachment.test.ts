import * as fsPromises from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { CardState } from '../src/types.js';
import { prepareFinalCardStateWithAttachment } from '../src/bridge/final-response-attachment.js';

const logger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

function completeState(responseText: string): CardState {
  return {
    status: 'complete',
    userPrompt: 'send plan',
    responseText,
    toolCalls: [],
  };
}

function sender(sendLocalFile: any) {
  return {
    sendLocalFile,
  } as any;
}

describe('prepareFinalCardStateWithAttachment', () => {
  it('leaves small responses inline and does not upload a file', async () => {
    const sendLocalFile = vi.fn();
    const state = completeState('short answer');
    const prepared = await prepareFinalCardStateWithAttachment({
      state,
      chatId: 'oc_small',
      sender: sender(sendLocalFile),
      logger,
    });

    expect(prepared).toBe(state);
    expect(sendLocalFile).not.toHaveBeenCalled();
  });

  it('uploads the full response and replaces card text with an explicit preview', async () => {
    const full = 'x'.repeat(13_000);
    let uploadedContent = '';
    const sendLocalFile = vi.fn(async (_chatId: string, filePath: string) => {
      uploadedContent = await fsPromises.readFile(filePath, 'utf8');
      return true;
    });

    const prepared = await prepareFinalCardStateWithAttachment({
      state: completeState(full),
      chatId: 'oc_big',
      sender: sender(sendLocalFile),
      logger,
    });

    expect(sendLocalFile).toHaveBeenCalledOnce();
    expect(uploadedContent).toBe(full);
    expect(prepared.responseText).toContain('Full response attached');
    expect(prepared.responseText.length).toBeLessThan(full.length);
  });

  it('surfaces attachment upload failure in the card preview', async () => {
    const full = 'x'.repeat(13_000);
    const sendLocalFile = vi.fn(async () => false);
    const prepared = await prepareFinalCardStateWithAttachment({
      state: completeState(full),
      chatId: 'oc_fail',
      sender: sender(sendLocalFile),
      logger,
    });

    expect(sendLocalFile).toHaveBeenCalledOnce();
    expect(prepared.responseText).toContain('attachment upload failed');
  });
});
