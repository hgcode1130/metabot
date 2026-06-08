import { describe, expect, it } from 'vitest';
import {
  classifyRetryableTaskError,
  retryDelayMs,
  retrySafetyDecision,
  shouldOpenProviderCircuit,
  taskErrorMetadata,
} from '../src/utils/retry-policy.js';

describe('retry policy', () => {
  it('classifies rate limits, overloads, service failures, malformed responses, and chat busy as retryable', () => {
    expect(classifyRetryableTaskError('API Error: 429 rate_limit_error')).toMatchObject({ retryable: true, kind: 'rate_limit' });
    expect(classifyRetryableTaskError('HTTP 503 service unavailable')).toMatchObject({ retryable: true, kind: 'service_unavailable' });
    expect(classifyRetryableTaskError('HTTP 529 overloaded_error')).toMatchObject({ retryable: true, kind: 'overloaded' });
    expect(classifyRetryableTaskError('API Error: 524 origin_response_timeout')).toMatchObject({ retryable: true, kind: 'gateway_timeout', code: 'gateway_timeout_524' });
    expect(classifyRetryableTaskError('API returned an empty or malformed response (HTTP 200)')).toMatchObject({ retryable: true, kind: 'malformed_response' });
    expect(classifyRetryableTaskError('Chat is busy with another task')).toMatchObject({ retryable: true, kind: 'chat_busy' });
  });

  it('does not retry auth/configuration, client, budget, or circuit errors', () => {
    expect(classifyRetryableTaskError('503 auth_not_found providers=codex')).toMatchObject({ retryable: false, code: 'auth_not_found' });
    expect(classifyRetryableTaskError('Task was stopped')).toMatchObject({ retryable: false, code: 'task_stopped' });
    expect(classifyRetryableTaskError('HTTP 403 permission_error')).toMatchObject({ retryable: false });
    expect(classifyRetryableTaskError('API Error: 400 Client not allowed (detected: claude-cli/2.1.168 (external, sdk-cli))'))
      .toMatchObject({ retryable: false, kind: 'client_not_allowed', code: 'client_not_allowed', status: 400 });
    expect(classifyRetryableTaskError('daily budget exhausted')).toMatchObject({ retryable: false });
    expect(classifyRetryableTaskError('Bot is temporarily unavailable (circuit open)')).toMatchObject({ retryable: false });
  });

  it('opens provider circuit for explicit provider health failures', () => {
    expect(shouldOpenProviderCircuit('503 auth_not_found providers=codex')).toBe(true);
    expect(shouldOpenProviderCircuit('API Error: 400 Client not allowed (detected: claude-cli/2.1.168 (external, cli))')).toBe(true);
    expect(shouldOpenProviderCircuit('HTTP 403 permission_error')).toBe(false);
  });

  it('uses retry-after for rate limits when present', () => {
    const classification = classifyRetryableTaskError({ status: 429, message: 'rate limit', headers: { 'retry-after': '7' } });
    expect(classification).toMatchObject({ retryable: true, kind: 'rate_limit', retryAfterMs: 7000 });
    if (classification.retryable) {
      expect(retryDelayMs(classification, 1, { jitter: false })).toBe(7000);
    }
  });

  it('requires explicit retry safety for gateway timeout and malformed HTTP 200', () => {
    const classification = classifyRetryableTaskError('API Error: 524 origin_response_timeout');
    expect(classification.retryable).toBe(true);
    if (!classification.retryable) return;

    expect(retrySafetyDecision(classification, undefined)).toMatchObject({
      allowed: false,
      sideEffectClass: 'unknown',
    });
    expect(retrySafetyDecision(classification, { sideEffectClass: 'readOnly' })).toMatchObject({ allowed: true });
    expect(retrySafetyDecision(classification, { sideEffectClass: 'localWrite' })).toMatchObject({
      allowed: false,
      sideEffectClass: 'localWrite',
    });
    expect(retrySafetyDecision(classification, { sideEffectClass: 'externalWrite', idempotencyKey: 'task-1' }))
      .toMatchObject({ allowed: true, idempotencyKey: 'task-1' });
  });

  it('produces compact metadata for activity and audit events', () => {
    expect(taskErrorMetadata('API returned an empty or malformed response (HTTP 200)')).toMatchObject({
      errorCode: 'malformed_response_http_200',
      errorKind: 'malformed_response',
      retryable: true,
      providerStatus: 200,
    });
  });
});
