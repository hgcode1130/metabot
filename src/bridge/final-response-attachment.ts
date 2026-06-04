import * as fsPromises from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import type { CardState } from '../types.js';
import type { Logger } from '../utils/logger.js';
import type { IMessageSender } from './message-sender.interface.js';
import {
  analyzeCardResponse,
  buildInlineResponsePreview,
} from '../feishu/card-response-elements.js';

const TEMP_DIR_PREFIX = 'metabot-response-';
const RESPONSE_FILE_PREFIX = 'metabot-response-';
const RESPONSE_FILE_EXT = '.md';
const ATTACHMENT_FAILED_TITLE = '⚠️ Attachment Failed';

interface SendFinalResponseAttachmentOptions {
  readonly responseText: string;
  readonly chatId: string;
  readonly sender: IMessageSender;
  readonly logger: Logger;
}

interface TempResponseFile {
  readonly filePath: string;
  readonly fileName: string;
  readonly tempDir: string;
}

function responseFileName(): string {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  return `${RESPONSE_FILE_PREFIX}${stamp}${RESPONSE_FILE_EXT}`;
}

async function writeTempResponseFile(text: string): Promise<TempResponseFile> {
  const tempDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), TEMP_DIR_PREFIX));
  const fileName = responseFileName();
  const filePath = path.join(tempDir, fileName);
  await fsPromises.writeFile(filePath, text, 'utf8');
  return { filePath, fileName, tempDir };
}

async function cleanupTempResponse(filePath: string, tempDir: string, logger: Logger): Promise<void> {
  try {
    await fsPromises.unlink(filePath);
    await fsPromises.rmdir(tempDir);
  } catch (err) {
    logger.warn({ err, filePath, tempDir }, 'Failed to clean temporary response attachment');
  }
}

async function sendResponseAttachment(options: SendFinalResponseAttachmentOptions, file: TempResponseFile): Promise<boolean> {
  const { chatId, sender, logger } = options;
  try {
    return await sender.sendLocalFile(chatId, file.filePath, file.fileName);
  } catch (err) {
    logger.error({ err, chatId, fileName: file.fileName }, 'Full response attachment upload threw');
    return false;
  }
}

async function notifyAttachmentFailure(
  options: SendFinalResponseAttachmentOptions,
  message: string,
): Promise<void> {
  const { chatId, sender, logger } = options;
  try {
    await sender.sendTextNotice(chatId, ATTACHMENT_FAILED_TITLE, message, 'orange');
  } catch (err) {
    logger.error({ err, chatId }, 'Failed to send full response attachment failure notice');
  }
}

export function prepareFinalCardStatePreview(state: CardState): CardState {
  if (!state.responseText) return state;
  if (!analyzeCardResponse(state.responseText).needsAttachment) return state;
  return {
    ...state,
    responseText: buildInlineResponsePreview(state.responseText),
  };
}

export async function sendFinalResponseAttachment(
  options: SendFinalResponseAttachmentOptions,
): Promise<void> {
  const { responseText, chatId, sender, logger } = options;
  if (!analyzeCardResponse(responseText).needsAttachment) return;

  let file: TempResponseFile;
  try {
    file = await writeTempResponseFile(responseText);
  } catch (err) {
    logger.error({ err, chatId }, 'Failed to create full response attachment');
    await notifyAttachmentFailure(
      options,
      'The final answer was shown as a card preview, but MetaBot could not create the full-response attachment.',
    );
    return;
  }

  const sent = await sendResponseAttachment(options, file);
  await cleanupTempResponse(file.filePath, file.tempDir, logger);
  if (!sent) {
    logger.error({ chatId, fileName: file.fileName }, 'Full response attachment upload failed');
    await notifyAttachmentFailure(
      options,
      'The final answer was shown as a card preview, but uploading the full-response attachment failed.',
    );
  }
}
