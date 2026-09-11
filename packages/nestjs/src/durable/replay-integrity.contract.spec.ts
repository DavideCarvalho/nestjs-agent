import { NondeterminismError } from '@dudousxd/durable-worker';
import { isReplayIntegrityError } from '@dudousxd/nestjs-agent-core';
import { NonDeterminismError } from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';

/**
 * `isReplayIntegrityError` matches by name because core depends on neither durable package. That
 * makes it silently breakable from outside: rename the class upstream and the guard stops firing
 * with nothing to notice. These assertions run against the REAL exported classes — the only place
 * in the repo where the two ends of that contract meet.
 */
describe('isReplayIntegrityError — pinned to the durable runtimes it has to recognise', () => {
  it('matches the in-process engine and the thin worker, which spell the name differently', () => {
    expect(isReplayIntegrityError(new NonDeterminismError('run-1', 3, 'a', 'b'))).toBe(true);
    expect(isReplayIntegrityError(new NondeterminismError('run-1', 3, 'a', 'b'))).toBe(true);
  });

  it('matches a runtime that qualifies the name rather than spelling it exactly', () => {
    const qualified = new Error('remote replay diverged');
    qualified.name = 'WorkflowNondeterminismError';
    expect(isReplayIntegrityError(qualified)).toBe(true);
  });

  it('leaves an ordinary tool failure alone, so it still reaches the model as a tool result', () => {
    expect(isReplayIntegrityError(new Error('deadlock found'))).toBe(false);
    expect(isReplayIntegrityError('not even an error')).toBe(false);
  });
});
