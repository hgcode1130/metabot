export type RetryableTaskErrorKind =
  | 'rate_limit'
  | 'service_unavailable'
  | 'overloaded'
  | 'malformed_response'
  | 'gateway_timeout'
  | 'chat_busy';

export type NonRetryableTaskErrorKind =
  | 'auth_configuration'
  | 'client_not_allowed'
  | 'client_error'
  | 'local_preflight'
  | 'stopped'
  | 'unknown';

export type TaskErrorKind = RetryableTaskErrorKind | NonRetryableTaskErrorKind;

export type TaskErrorCode =
  | 'rate_limit_429'
  | 'service_unavailable_503'
  | 'overloaded_529'
  | 'malformed_response_http_200'
  | 'gateway_timeout_524'
  | 'chat_busy'
  | 'auth_not_found'
  | 'auth_configuration_error'
  | 'client_not_allowed'
  | 'client_error'
  | 'local_preflight_rejection'
  | 'task_stopped'
  | 'unknown_error';

export interface RetryableTaskError {
  retryable: true;
  kind: RetryableTaskErrorKind;
  code: TaskErrorCode;
  reason: string;
  status?: number;
  retryAfterMs?: number;
}

export interface NonRetryableTaskError {
  retryable: false;
  kind?: NonRetryableTaskErrorKind;
  code?: TaskErrorCode;
  reason?: string;
  status?: number;
}

export type RetryableTaskErrorClassification = RetryableTaskError | NonRetryableTaskError;

export interface TaskErrorMetadata {
  errorCode?: TaskErrorCode;
  errorKind?: TaskErrorKind;
  retryable: boolean;
  providerStatus?: number;
  errorReason?: string;
}

export type SideEffectClass = 'none' | 'readOnly' | 'externalWrite' | 'unknown';

export interface RetrySafetyDecision {
  allowed: boolean;
  sideEffectClass: SideEffectClass;
  idempotencyKey?: string;
  reason?: string;
}

export interface RetrySafetyMetadata {
  sideEffectClass?: unknown;
  idempotencyKey?: unknown;
}

const PROVIDER_BACKOFF_MS = [30_000, 60_000, 120_000, 240_000, 480_000];
const CHAT_BUSY_BACKOFF_MS = [2_000, 5_000, 10_000, 20_000, 30_000];
const MAX_BACKOFF_MS = 10 * 60 * 1000;

export function classifyRetryableTaskError(input: unknown): RetryableTaskErrorClassification {
  const text = extractErrorText(input);
  const status = extractStatus(input) ?? extractStatusFromText(text);
  const lower = text.toLowerCase();

  if (!text && status === undefined) return { retryable: false };

  if (/task was stopped|aborted by user|error_cancelled/i.test(text)) {
    return nonRetryable('stopped', 'task_stopped', text || 'task stopped', status);
  }
  if (/auth_not_found|authentication_error|permission_error|invalid api key|api key lacks|required auth/i.test(text)) {
    const code = /auth_not_found/i.test(text) ? 'auth_not_found' : 'auth_configuration_error';
    return nonRetryable('auth_configuration', code, 'auth/configuration error', status);
  }
  if (/client not allowed/i.test(text)) {
    return nonRetryable(
      'client_not_allowed',
      'client_not_allowed',
      'provider rejected this client type',
      status,
    );
  }
  if (/budget|circuit open|temporarily unavailable \(circuit open\)|daily budget/i.test(text)) {
    return nonRetryable('local_preflight', 'local_preflight_rejection', 'local preflight rejection', status);
  }
  if (status && [400, 401, 403, 404, 413].includes(status)) {
    return nonRetryable('client_error', 'client_error', `non-retryable HTTP ${status}`, status);
  }

  if (status === 429 || /\b429\b|rate_limit_error|rate limited|too many requests|retry-after/i.test(text)) {
    return retryable('rate_limit', 'rate_limit_429', text || 'rate limited', status, extractRetryAfterMs(input, text));
  }
  if (status === 524 || /\b524\b|origin_response_timeout/i.test(text)) {
    return retryable('gateway_timeout', 'gateway_timeout_524', text || 'gateway timeout', status);
  }
  if (status === 529 || /\b529\b|overloaded_error|overloaded/i.test(text)) {
    return retryable('overloaded', 'overloaded_529', text || 'overloaded', status);
  }
  if (status === 503 || /\b503\b|service unavailable|temporarily unavailable/i.test(text)) {
    return retryable('service_unavailable', 'service_unavailable_503', text || 'service unavailable', status);
  }
  if (/chat is busy with another task/i.test(text)) {
    return retryable('chat_busy', 'chat_busy', text, status);
  }
  if (/http\s*200/i.test(text) && /empty|malformed|invalid json|parse|unexpected token|unexpected end/i.test(lower)) {
    return retryable('malformed_response', 'malformed_response_http_200', text, status ?? 200);
  }

  return nonRetryable('unknown', text ? 'unknown_error' : undefined, text || undefined, status);
}

export function taskErrorMetadata(input: unknown): TaskErrorMetadata {
  const classification = classifyRetryableTaskError(input);
  return {
    errorCode: classification.code,
    errorKind: classification.kind,
    retryable: classification.retryable,
    providerStatus: classification.status,
    errorReason: classification.reason,
  };
}

export function shouldOpenProviderCircuit(input: unknown): boolean {
  const code = classifyRetryableTaskError(input).code;
  return code === 'auth_not_found' || code === 'client_not_allowed';
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

export function retrySafetyDecision(
  classification: RetryableTaskError,
  metadata: RetrySafetyMetadata | undefined,
): RetrySafetyDecision {
  const sideEffectClass = readSideEffectClass(metadata?.sideEffectClass);
  const idempotencyKey = readIdempotencyKey(metadata?.idempotencyKey);
  if (!requiresExplicitRetrySafety(classification)) {
    return { allowed: true, sideEffectClass, idempotencyKey };
  }
  if (sideEffectClass === 'none' || sideEffectClass === 'readOnly') {
    return { allowed: true, sideEffectClass, idempotencyKey };
  }
  if (idempotencyKey) {
    return { allowed: true, sideEffectClass, idempotencyKey };
  }
  return {
    allowed: false,
    sideEffectClass,
    reason: 'Retry paused: declare sideEffectClass=none/readOnly or provide idempotencyKey',
  };
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

function requiresExplicitRetrySafety(classification: RetryableTaskError): boolean {
  return classification.kind === 'gateway_timeout' || classification.kind === 'malformed_response';
}

function readSideEffectClass(value: unknown): SideEffectClass {
  if (value === 'none' || value === 'readOnly' || value === 'externalWrite') return value;
  return 'unknown';
}

function readIdempotencyKey(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

function extractStatusFromText(text: string): number | undefined {
  const match = text.match(/\b(?:HTTP|API Error:)?\s*(\d{3})\b/i);
  if (!match) return undefined;
  const parsed = Number(match[1]);
  return Number.isInteger(parsed) ? parsed : undefined;
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

function retryable(
  kind: RetryableTaskErrorKind,
  code: TaskErrorCode,
  reason: string,
  status?: number,
  retryAfterMs?: number,
): RetryableTaskError {
  return { retryable: true, kind, code, reason, status, retryAfterMs };
}

function nonRetryable(
  kind: NonRetryableTaskErrorKind,
  code: TaskErrorCode | undefined,
  reason: string | undefined,
  status?: number,
): NonRetryableTaskError {
  return { retryable: false, kind, code, reason, status };
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
