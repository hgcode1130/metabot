import pino from 'pino';

const SECRET_KEY_RE = /api[_-]?key|token|password|secret|authorization|webhook|oauth/i;
const TOKEN_QUERY_RE = /([?&](?:token|access_token|auth|code)=)[^&#\s]+/gi;
const AUTH_HEADER_RE = /\bauthorization\s*[:=]\s*Bearer\s+[A-Za-z0-9._~+/=-]+/gi;
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]+/gi;
const KEY_VALUE_SECRET_RE = /\b(api[_-]?key|token|password|secret|authorization|oauth[_-]?code)\s*[:=]\s*["']?[^"',&\s}]+/gi;
const MAX_REDACTION_DEPTH = 5;

export function createLogger(level: string) {
  return pino({
    level,
    formatters: {
      log: (object) => redactLogValue(object) as Record<string, unknown>,
    },
    transport: {
      target: 'pino-pretty',
      options: {
        colorize: true,
        translateTime: 'SYS:standard',
        ignore: 'pid,hostname',
      },
    },
  });
}

export type Logger = pino.Logger;

export function redactLogValue(value: unknown, depth = 0): unknown {
  if (typeof value === 'string') return redactString(value);
  if (!value || typeof value !== 'object') return value;
  if (depth >= MAX_REDACTION_DEPTH) return '[redacted-depth-limit]';
  if (Array.isArray(value)) return value.map((item) => redactLogValue(item, depth + 1));
  return redactLogObject(value as Record<string, unknown>, depth);
}

function redactLogObject(value: Record<string, unknown>, depth: number): Record<string, unknown> {
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value)) {
    output[key] = SECRET_KEY_RE.test(key) ? '[redacted]' : redactLogValue(item, depth + 1);
  }
  return output;
}

function redactString(value: string): string {
  return value
    .replace(TOKEN_QUERY_RE, '$1[redacted]')
    .replace(AUTH_HEADER_RE, 'Authorization=[redacted]')
    .replace(BEARER_RE, 'Bearer [redacted]')
    .replace(KEY_VALUE_SECRET_RE, (_match, key) => `${key}=[redacted]`);
}
