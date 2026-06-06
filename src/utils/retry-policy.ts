export type RetryableTaskErrorKind = 'rate_limit' | 'service_unavailable' | 'overloaded' | 'malformed_response' | 'chat_busy';

export interface RetryableTaskError {
  retryable: true;
  kind: RetryableTaskErrorKind;
  reason: string;
  retryAfterMs?: number;
}

export interface NonRetryableTaskError {
  retryable: false;
  reason?: string;
}

export type RetryableTaskErrorClassification = RetryableTaskError | NonRetryableTaskError;

const PROVIDER_BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 480_000];
const CHAT_BUSY_BACKOFF_MS = [2_000, 5_000, 10_000, 20_000, 30_000];
const MAX_BACKOFF_MS = 10 * 60 * 1000;

export function classifyRetryableTaskError(input: unknown): RetryableTaskErrorClassification {
  const status = extractStatus(input);
  const text = extractErrorText(input);
  const lower = text.toLowerCase();

  if (!text && status === undefined) return { retryable: false };

  if (/auth_not_found|authentication_error|permission_error|invalid api key|api key lacks|required auth/i.test(text)) {
    return { retryable: false, reason: 'auth/configuration error' };
  }
  if (/budget|circuit open|temporarily unavailable \(circuit open\)|daily budget/i.test(text)) {
    return { retryable: false, reason: 'local preflight rejection' };
  }
  if (status && [400, 401, 403, 404, 413].includes(status)) {
    return { retryable: false, reason: `non-retryable HTTP ${status}` };
  }

  if (status === 429 || /\b429\b|rate_limit_error|rate limited|too many requests|retry-after/i.test(text)) {
    return { retryable: true, kind: 'rate_limit', reason: text || 'rate limited', retryAfterMs: extractRetryAfterMs(input, text) };
  }
  if (status === 529 || /\b529\b|overloaded_error|overloaded/i.test(text)) {
    return { retryable: true, kind: 'overloaded', reason: text || 'overloaded' };
  }
  if (status === 503 || /\b503\b|service unavailable|temporarily unavailable/i.test(text)) {
    return { retryable: true, kind: 'service_unavailable', reason: text || 'service unavailable' };
  }
  if (/chat is busy with another task/i.test(text)) {
    return { retryable: true, kind: 'chat_busy', reason: text };
  }
  if (/http\s*200/i.test(text) && /empty|malformed|invalid json|parse|unexpected token|unexpected end/i.test(lower)) {
    return { retryable: true, kind: 'malformed_response', reason: text };
  }

  return { retryable: false, reason: text || undefined };
}

export function retryDelayMs(
  classification: RetryableTaskError,
  retryNumber: number,
  options: { jitter?: boolean } = {},
): number {
  const schedule = classification.kind === 'chat_busy' ? CHAT_BUSY_BACKOFF_MS : PROVIDER_BACKOFF_MS;
  const base = classification.kind === 'rate_limit' && classification.retryAfterMs
    ? classification.retryAfterMs
    : schedule[Math.min(Math.max(retryNumber - 1, 0), schedule.length - 1)];
  const capped = Math.min(base, MAX_BACKOFF_MS);
  if (options.jitter === false) return capped;
  return Math.min(MAX_BACKOFF_MS, Math.round(capped * (1 + Math.random() * 0.25)));
}

export function maxRetriesFor(_classification: RetryableTaskError): number {
  return 5;
}

function extractStatus(input: unknown): number | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const obj = input as Record<string, unknown>;
  const candidates = [obj.status, obj.statusCode, obj.code];
  for (const candidate of candidates) {
    if (typeof candidate === 'number' && Number.isInteger(candidate)) return candidate;
    if (typeof candidate === 'string') {
      const parsed = Number(candidate);
      if (Number.isInteger(parsed)) return parsed;
    }
  }
  const response = obj.response as Record<string, unknown> | undefined;
  if (response && typeof response.status === 'number') return response.status;
  return undefined;
}

function extractErrorText(input: unknown): string {
  if (!input) return '';
  if (typeof input === 'string') return input;
  if (input instanceof Error) return input.message;
  if (typeof input !== 'object') return String(input);
  const obj = input as Record<string, unknown>;
  const parts = [obj.error, obj.message, obj.errorMessage, obj.responseText]
    .filter((part): part is string => typeof part === 'string' && part.length > 0);
  if (parts.length > 0) return parts.join(' ');
  try {
    return JSON.stringify(input);
  } catch {
    return String(input);
  }
}

function extractRetryAfterMs(input: unknown, text: string): number | undefined {
  if (input && typeof input === 'object') {
    const obj = input as Record<string, unknown>;
    const headers = (obj.headers || (obj.response as Record<string, unknown> | undefined)?.headers) as Record<string, unknown> | undefined;
    const retryAfter = headers?.['retry-after'] ?? headers?.['Retry-After'];
    const parsed = parseRetryAfter(retryAfter);
    if (parsed !== undefined) return parsed;
  }
  const match = text.match(/retry-after[=: ]+(\d+)/i);
  if (match) return Number(match[1]) * 1000;
  return undefined;
}

function parseRetryAfter(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.max(0, value * 1000);
  if (typeof value !== 'string') return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.max(0, seconds * 1000);
  const dateMs = Date.parse(value);
  if (Number.isFinite(dateMs)) return Math.max(0, dateMs - Date.now());
  return undefined;
}
