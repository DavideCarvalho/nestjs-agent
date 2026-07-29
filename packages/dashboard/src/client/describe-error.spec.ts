import { describe, expect, it } from 'vitest';
import { describeError, errorStatus } from './describe-error';

describe('errorStatus', () => {
  it('reads the status off the shape agentClient throws', () => {
    expect(errorStatus(new Error('503 Service Unavailable'))).toBe(503);
  });

  it('is null for a fetch rejection that never reached the API', () => {
    expect(errorStatus(new TypeError('Failed to fetch'))).toBeNull();
  });

  it('does not read a status out of the middle of a message', () => {
    expect(errorStatus(new Error('upstream returned 500 after 3 attempts'))).toBeNull();
  });
});

describe('describeError', () => {
  it('keeps the thrown message verbatim', () => {
    expect(describeError(new Error('503 Service Unavailable')).message).toBe(
      '503 Service Unavailable',
    );
  });

  it('marks a 501 as not retryable — it is a configuration answer', () => {
    const described = describeError(new Error('501 Not Implemented'));
    expect(described.status).toBe(501);
    expect(described.retryable).toBe(false);
  });

  it('marks a rejected session as not retryable', () => {
    expect(describeError(new Error('401 Unauthorized')).retryable).toBe(false);
    expect(describeError(new Error('403 Forbidden')).retryable).toBe(false);
  });

  it('marks a 5xx and an unreachable API as retryable', () => {
    expect(describeError(new Error('500 Internal Server Error')).retryable).toBe(true);
    expect(describeError(new TypeError('Failed to fetch')).retryable).toBe(true);
  });

  it('falls back to a message for a non-Error throw', () => {
    expect(describeError(undefined).message).toBe('Unknown error');
    expect(describeError('boom').message).toBe('boom');
  });
});
