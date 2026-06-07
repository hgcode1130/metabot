import { describe, expect, it } from 'vitest';
import { redactLogValue } from '../src/utils/logger.js';

describe('logger redaction', () => {
  it('redacts common token and secret shapes without hiding ordinary fields', () => {
    expect(
      redactLogValue({
        url: 'http://localhost:8100?token=secret-value&x=1',
        authorization: 'Bearer direct-token',
        nested: {
          message: 'Authorization: Bearer abc.def',
          apiKey: 'key-value',
          ok: 'visible',
        },
      }),
    ).toEqual({
      url: 'http://localhost:8100?token=[redacted]&x=1',
      authorization: '[redacted]',
      nested: {
        message: 'Authorization=[redacted]',
        apiKey: '[redacted]',
        ok: 'visible',
      },
    });
  });
});
