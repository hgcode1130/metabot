import type { SDKMessage } from '../engines/index.js';
import type { CardState } from '../types.js';

const CHECKPOINT_INTERVAL_MS = 10_000;
const PREVIEW_LIMIT = 1000;
const TEXT_LIMIT = 2000;
const SECRET_PATTERN = /(api[_-]?key|token|password|secret|bearer)\s*[:=]\s*["']?[^"'\s,}]+/gi;

export interface ManagerCheckpointPayload {
  attempt: number;
  workerChatId: string;
  sessionId?: string;
  status?: string;
  responsePreview?: string;
  toolCalls?: unknown[];
  costUsd?: number;
  durationMs?: number;
  totalTokens?: number;
  source?: 'raw' | 'update' | 'final';
}

export class ManagerCheckpointWriter {
  private lastCheckpointAt = 0;

  constructor(
    private readonly append: (payload: ManagerCheckpointPayload) => void,
    private readonly base: Pick<ManagerCheckpointPayload, 'attempt' | 'workerChatId'>,
  ) {}

  fromRaw(message: SDKMessage): void {
    if (!this.shouldWrite(false)) return;
    const payload = {
      ...this.base,
      source: 'raw' as const,
      responsePreview: preview(extractRawText(message)),
    };
    this.append(payload);
  }

  fromUpdate(state: CardState, final: boolean): void {
    if (!this.shouldWrite(final)) return;
    this.append({
      ...this.base,
      source: final ? 'final' : 'update',
      sessionId: stringValue((state as { sessionId?: unknown }).sessionId),
      status: state.status,
      responsePreview: preview(state.responseText),
      toolCalls: sanitizeToolCalls(state.toolCalls),
      costUsd: state.costUsd,
      durationMs: state.durationMs,
      totalTokens: state.totalTokens,
    });
  }

  final(state?: Partial<CardState>, error?: string): void {
    this.append({
      ...this.base,
      source: 'final',
      status: state?.status,
      responsePreview: preview(state?.responseText ?? error),
      toolCalls: sanitizeToolCalls(state?.toolCalls),
      costUsd: state?.costUsd,
      durationMs: state?.durationMs,
      totalTokens: state?.totalTokens,
    });
  }

  private shouldWrite(force: boolean): boolean {
    const now = Date.now();
    if (!force && now - this.lastCheckpointAt < CHECKPOINT_INTERVAL_MS) return false;
    this.lastCheckpointAt = now;
    return true;
  }
}

export function checkpointSummary(payload: unknown): string {
  if (!payload || typeof payload !== 'object') return 'No checkpoint summary available.';
  const checkpoint = payload as ManagerCheckpointPayload;
  const parts = [
    checkpoint.status ? `status=${checkpoint.status}` : undefined,
    checkpoint.responsePreview ? `preview=${checkpoint.responsePreview}` : undefined,
    checkpoint.totalTokens ? `tokens=${checkpoint.totalTokens}` : undefined,
    checkpoint.costUsd ? `costUsd=${checkpoint.costUsd}` : undefined,
  ].filter((part): part is string => !!part);
  return parts.join('; ') || 'No checkpoint summary available.';
}

function extractRawText(message: SDKMessage): string | undefined {
  const raw = message as unknown as { message?: { content?: unknown }; result?: unknown };
  if (typeof raw.result === 'string') return raw.result;
  const content = raw.message?.content;
  if (!Array.isArray(content)) return undefined;
  const text = content
    .map((block) => (block as { type?: string; text?: unknown }).text)
    .filter((value): value is string => typeof value === 'string')
    .join('\n');
  return text || undefined;
}

function preview(value: unknown): string | undefined {
  if (typeof value !== 'string' || value.trim() === '') return undefined;
  return redact(value).slice(0, PREVIEW_LIMIT);
}

function sanitizeToolCalls(value: unknown): unknown[] | undefined {
  if (!Array.isArray(value) || value.length === 0) return undefined;
  return value.slice(0, 20).map((item) => sanitizeValue(item, 0));
}

function sanitizeValue(value: unknown, depth: number): unknown {
  if (depth > 3) return '[truncated]';
  if (typeof value === 'string') return redact(value).slice(0, TEXT_LIMIT);
  if (!value || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitizeValue(item, depth + 1));
  return sanitizeObject(value as Record<string, unknown>, depth);
}

function sanitizeObject(value: Record<string, unknown>, depth: number): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 40)) {
    output[key] = isSensitiveKey(key) ? '[redacted]' : sanitizeValue(item, depth + 1);
  }
  return output;
}

function redact(value: string): string {
  return value.replace(SECRET_PATTERN, (_match, key) => `${key}: [redacted]`);
}

function isSensitiveKey(key: string): boolean {
  return /api[_-]?key|token|password|secret|authorization/i.test(key);
}

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value ? value : undefined;
}
