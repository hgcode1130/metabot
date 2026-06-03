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

interface PrepareFinalCardStateOptions {
  readonly state: CardState;
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

async function sendResponseAttachment(
  chatId: string,
  sender: IMessageSender,
  file: TempResponseFile,
  logger: Logger,
): Promise<boolean> {
  try {
    return await sender.sendLocalFile(chatId, file.filePath, file.fileName);
  } catch (err) {
    logger.error({ err, chatId, fileName: file.fileName }, 'Full response attachment upload threw');
    return false;
  }
}

export async function prepareFinalCardStateWithAttachment(
  options: PrepareFinalCardStateOptions,
): Promise<CardState> {
  const { state, chatId, sender, logger } = options;
  if (!state.responseText) return state;
  if (!analyzeCardResponse(state.responseText).needsAttachment) return state;

  let file: TempResponseFile;
  try {
    file = await writeTempResponseFile(state.responseText);
  } catch (err) {
    logger.error({ err, chatId }, 'Failed to create full response attachment');
    return { ...state, responseText: buildInlineResponsePreview(state.responseText, undefined, true) };
  }

  const sent = await sendResponseAttachment(chatId, sender, file, logger);
  await cleanupTempResponse(file.filePath, file.tempDir, logger);
  if (!sent) {
    logger.error({ chatId, fileName: file.fileName }, 'Full response attachment upload failed');
  }
  return {
    ...state,
    responseText: buildInlineResponsePreview(state.responseText, sent ? file.fileName : undefined, !sent),
  };
}
