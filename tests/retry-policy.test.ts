import { describe, expect, it } from 'vitest';
import { classifyRetryableTaskError, retryDelayMs } from '../src/utils/retry-policy.js';

describe('retry policy', () => {
  it('classifies rate limits, overloads, service failures, malformed responses, and chat busy as retryable', () => {
    expect(classifyRetryableTaskError('API Error: 429 rate_limit_error')).toMatchObject({ retryable: true, kind: 'rate_limit' });
    expect(classifyRetryableTaskError('HTTP 503 service unavailable')).toMatchObject({ retryable: true, kind: 'service_unavailable' });
    expect(classifyRetryableTaskError('HTTP 529 overloaded_error')).toMatchObject({ retryable: true, kind: 'overloaded' });
    expect(classifyRetryableTaskError('API returned an empty or malformed response (HTTP 200)')).toMatchObject({ retryable: true, kind: 'malformed_response' });
    expect(classifyRetryableTaskError('Chat is busy with another task')).toMatchObject({ retryable: true, kind: 'chat_busy' });
  });

  it('does not retry auth/configuration, client, budget, or circuit errors', () => {
    expect(classifyRetryableTaskError('503 auth_not_found providers=codex')).toMatchObject({ retryable: false });
    expect(classifyRetryableTaskError('HTTP 403 permission_error')).toMatchObject({ retryable: false });
    expect(classifyRetryableTaskError('daily budget exhausted')).toMatchObject({ retryable: false });
    expect(classifyRetryableTaskError('Bot is temporarily unavailable (circuit open)')).toMatchObject({ retryable: false });
  });

  it('uses retry-after for rate limits when present', () => {
    const classification = classifyRetryableTaskError({ status: 429, message: 'rate limit', headers: { 'retry-after': '7' } });
    expect(classification).toMatchObject({ retryable: true, kind: 'rate_limit', retryAfterMs: 7000 });
    if (classification.retryable) {
      expect(retryDelayMs(classification, 1, { jitter: false })).toBe(7000);
    }
  });
});
