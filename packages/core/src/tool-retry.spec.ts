import { describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_TOOL_TRANSIENT_RETRY_ATTEMPTS,
  DEFAULT_TOOL_TRANSIENT_RETRY_BACKOFF_MS,
  invokeWithTransientRetry,
  isTransientToolError,
  resolveToolTransientRetryNumbers,
} from './tool-retry.js';

describe('isTransientToolError', () => {
  it('recognizes MySQL numeric deadlock/lock-wait-timeout codes (code and errno)', () => {
    expect(isTransientToolError({ code: 1213, message: 'x' })).toBe(true);
    expect(isTransientToolError({ code: 1205, message: 'x' })).toBe(true);
    expect(isTransientToolError({ errno: 1213, message: 'x' })).toBe(true);
    expect(isTransientToolError({ errno: 1205, message: 'x' })).toBe(true);
  });

  it('recognizes MySQL string codes', () => {
    expect(isTransientToolError({ code: 'ER_LOCK_DEADLOCK' })).toBe(true);
    expect(isTransientToolError({ code: 'ER_LOCK_WAIT_TIMEOUT' })).toBe(true);
  });

  it('recognizes Postgres serialization/deadlock SQLSTATEs (code or sqlState)', () => {
    expect(isTransientToolError({ code: '40001' })).toBe(true);
    expect(isTransientToolError({ code: '40P01' })).toBe(true);
    expect(isTransientToolError({ sqlState: '40001' })).toBe(true);
    expect(isTransientToolError({ sqlState: '40P01' })).toBe(true);
  });

  it('recognizes SQLITE_BUSY', () => {
    expect(isTransientToolError({ code: 'SQLITE_BUSY' })).toBe(true);
  });

  it('recognizes a matching message with no structured code (deadlock / lock wait timeout / serialization failure)', () => {
    expect(isTransientToolError(new Error('Deadlock found when trying to get lock'))).toBe(true);
    expect(
      isTransientToolError(new Error('Lock wait timeout exceeded; try restarting transaction')),
    ).toBe(true);
    expect(
      isTransientToolError(new Error('could not serialize access due to serialization failure')),
    ).toBe(true);
  });

  it('is false for a plain Error with none of these markers', () => {
    expect(isTransientToolError(new Error('city not found'))).toBe(false);
  });

  it('is false for non-object / null errors', () => {
    expect(isTransientToolError('boom')).toBe(false);
    expect(isTransientToolError(null)).toBe(false);
    expect(isTransientToolError(undefined)).toBe(false);
  });

  it('walks one level of `cause` (drivers commonly wrap the original error)', () => {
    const wrapped = new Error('query failed', { cause: { code: 'ER_LOCK_DEADLOCK' } });
    expect(isTransientToolError(wrapped)).toBe(true);
  });

  it('does not walk a self-referential cause into an infinite loop', () => {
    const selfCause: { message: string; cause?: unknown } = { message: 'oops' };
    selfCause.cause = selfCause;
    expect(isTransientToolError(selfCause)).toBe(false);
  });

  it('does not treat a non-transient cause as transient', () => {
    const wrapped = new Error('query failed', { cause: new Error('permission denied') });
    expect(isTransientToolError(wrapped)).toBe(false);
  });
});

describe('resolveToolTransientRetryNumbers', () => {
  it('resolves undefined to the concrete defaults (never leaves it undefined)', () => {
    expect(resolveToolTransientRetryNumbers(undefined)).toEqual({
      attempts: DEFAULT_TOOL_TRANSIENT_RETRY_ATTEMPTS,
      backoffMs: DEFAULT_TOOL_TRANSIENT_RETRY_BACKOFF_MS,
    });
  });

  it('fills in only the missing half of a partial setting', () => {
    expect(resolveToolTransientRetryNumbers({ attempts: 5 })).toEqual({
      attempts: 5,
      backoffMs: DEFAULT_TOOL_TRANSIENT_RETRY_BACKOFF_MS,
    });
  });

  it('passes through `false` untouched', () => {
    expect(resolveToolTransientRetryNumbers(false)).toBe(false);
  });
});

/** A structural MySQL-deadlock-shaped error the default classifier recognizes. */
function deadlockError(): Error & { code: string } {
  return Object.assign(new Error('deadlock'), { code: 'ER_LOCK_DEADLOCK' });
}

describe('invokeWithTransientRetry', () => {
  it('transient error then success → one retry, result returned', async () => {
    let calls = 0;
    const onRetry = vi.fn();
    const result = await invokeWithTransientRetry(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw deadlockError();
        }
        return 'ok';
      },
      { attempts: 2, backoffMs: 1 },
      { onRetry },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry).toHaveBeenCalledWith(1, expect.any(Error));
  });

  it('non-transient error → immediate rethrow, no retry', async () => {
    let calls = 0;
    const onRetry = vi.fn();
    await expect(
      invokeWithTransientRetry(
        async () => {
          calls += 1;
          throw new Error('business rule violated');
        },
        { attempts: 3, backoffMs: 1 },
        { onRetry },
      ),
    ).rejects.toThrow('business rule violated');
    expect(calls).toBe(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('attempts exhausted → rethrows the (still-transient) error', async () => {
    let calls = 0;
    await expect(
      invokeWithTransientRetry(
        async () => {
          calls += 1;
          throw deadlockError();
        },
        { attempts: 2, backoffMs: 1 },
      ),
    ).rejects.toThrow('deadlock');
    expect(calls).toBe(2);
  });

  it('`false` policy → no wrapping at all (calls fn once, whatever it throws)', async () => {
    let calls = 0;
    await expect(
      invokeWithTransientRetry(async () => {
        calls += 1;
        throw deadlockError();
      }, false),
    ).rejects.toThrow('deadlock');
    expect(calls).toBe(1);
  });

  it('control-flow error → immediate rethrow even when classify says transient', async () => {
    class FakeSuspendSignal extends Error {}
    let calls = 0;
    const onRetry = vi.fn();
    await expect(
      invokeWithTransientRetry(
        async () => {
          calls += 1;
          throw new FakeSuspendSignal('suspend');
        },
        { attempts: 3, backoffMs: 1, classify: () => true },
        { isControlFlowError: (error) => error instanceof FakeSuspendSignal, onRetry },
      ),
    ).rejects.toThrow(FakeSuspendSignal);
    expect(calls).toBe(1);
    expect(onRetry).not.toHaveBeenCalled();
  });

  it('a custom classify widens what counts as transient', async () => {
    let calls = 0;
    const result = await invokeWithTransientRetry(
      async () => {
        calls += 1;
        if (calls === 1) {
          throw new Error('rate limited, try again');
        }
        return 'ok';
      },
      {
        attempts: 2,
        backoffMs: 1,
        classify: (error) => error instanceof Error && /rate limited/.test(error.message),
      },
    );
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });

  it('waits backoffMs * attemptNumber between attempts', async () => {
    vi.useFakeTimers();
    try {
      let calls = 0;
      const promise = invokeWithTransientRetry(
        async () => {
          calls += 1;
          if (calls < 3) {
            throw deadlockError();
          }
          return 'ok';
        },
        { attempts: 3, backoffMs: 100 },
      );
      // Let the first attempt run and schedule its backoff timer.
      await vi.advanceTimersByTimeAsync(0);
      expect(calls).toBe(1);
      await vi.advanceTimersByTimeAsync(100); // backoffMs * 1
      expect(calls).toBe(2);
      await vi.advanceTimersByTimeAsync(200); // backoffMs * 2
      expect(calls).toBe(3);
      await expect(promise).resolves.toBe('ok');
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies the default attempts/backoffMs when the setting omits them', async () => {
    let calls = 0;
    const result = await invokeWithTransientRetry(async () => {
      calls += 1;
      if (calls === 1) {
        throw deadlockError();
      }
      return 'ok';
    }, {});
    expect(result).toBe('ok');
    expect(calls).toBe(2);
  });
});
