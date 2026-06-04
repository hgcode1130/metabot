import * as fsPromises from 'node:fs/promises';
import { describe, expect, it, vi } from 'vitest';
import type { CardState } from '../src/types.js';
import {
  prepareFinalCardStatePreview,
  sendFinalResponseAttachment,
} from '../src/bridge/final-response-attachment.js';

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

function sender(sendLocalFile: any, sendTextNotice: any = vi.fn()) {
  return {
    sendLocalFile,
    sendTextNotice,
  } as any;
}

describe('final response attachment handling', () => {
  it('leaves small responses inline and does not upload a file', async () => {
    const sendLocalFile = vi.fn();
    const state = completeState('short answer');
    const prepared = prepareFinalCardStatePreview(state);

    expect(prepared).toBe(state);
    expect(sendLocalFile).not.toHaveBeenCalled();
  });

  it('builds the final card preview without waiting for file upload', () => {
    const full = 'x'.repeat(13_000);
    const state = completeState(full);
    const prepared = prepareFinalCardStatePreview(state);

    expect(prepared.responseText).toContain('Response shortened for Feishu card limits');
    expect(prepared.responseText.length).toBeLessThan(full.length);
  });

  it('sends the full response attachment separately', async () => {
    const full = 'x'.repeat(13_000);
    let uploadedContent = '';
    const sendLocalFile = vi.fn(async (_chatId: string, filePath: string) => {
      uploadedContent = await fsPromises.readFile(filePath, 'utf8');
      return true;
    });

    await sendFinalResponseAttachment({
      responseText: full,
      chatId: 'oc_later',
      sender: sender(sendLocalFile),
      logger,
    });

    expect(sendLocalFile).toHaveBeenCalledOnce();
    expect(uploadedContent).toBe(full);
  });

  it('does not send an attachment for responses that fit in the card', async () => {
    const sendLocalFile = vi.fn();
    await sendFinalResponseAttachment({
      responseText: 'short answer',
      chatId: 'oc_short',
      sender: sender(sendLocalFile),
      logger,
    });

    expect(sendLocalFile).not.toHaveBeenCalled();
  });

  it('notifies the user when attachment upload fails', async () => {
    const full = 'x'.repeat(13_000);
    const sendLocalFile = vi.fn(async () => false);
    const sendTextNotice = vi.fn();

    await sendFinalResponseAttachment({
      responseText: full,
      chatId: 'oc_fail',
      sender: sender(sendLocalFile, sendTextNotice),
      logger,
    });

    expect(sendLocalFile).toHaveBeenCalledOnce();
    expect(sendTextNotice).toHaveBeenCalledWith(
      'oc_fail',
      '⚠️ Attachment Failed',
      expect.stringContaining('uploading the full-response attachment failed'),
      'orange',
    );
  });
});
