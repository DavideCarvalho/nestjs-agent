import { Cancelled, StepFailed, Suspend } from '@dudousxd/durable-worker';
import { isControlFlowSignal } from '@dudousxd/nestjs-agent-core';
import { ContinueAsNew, WorkflowSuspended } from '@dudousxd/nestjs-durable-core';
import { describe, expect, it } from 'vitest';

/**
 * Core recognises a durable control-flow signal by a `Symbol.for` marker it declares locally, so it
 * can stay free of a durable dependency. The cost is a coupling nothing type-checks: change the key
 * upstream and every suspend silently becomes a tool failure. These assertions run against the REAL
 * signal classes of both runtimes, which is the only thing that can catch that.
 *
 * The two negatives matter as much as the positives. `Cancelled` is a terminal outcome a consumer
 * may want to observe, and `StepFailed` is a genuine failure a `catch` is meant to compensate for;
 * widening the predicate onto either would swallow them (see `isWorkflowControlFlowSignal`'s own
 * doc, which names both as deliberately excluded).
 */
describe('isControlFlowSignal — pinned to the durable runtimes it has to recognise', () => {
  it('matches the in-process engine signals', () => {
    expect(isControlFlowSignal(new WorkflowSuspended())).toBe(true);
    expect(isControlFlowSignal(new ContinueAsNew(undefined))).toBe(true);
  });

  it('matches the thin worker signal, a different class for the same event', () => {
    expect(isControlFlowSignal(new Suspend())).toBe(true);
  });

  it('does not match a cancellation or a failed step, which callers must still handle', () => {
    expect(isControlFlowSignal(new Cancelled('run-1'))).toBe(false);
    expect(isControlFlowSignal(new StepFailed({ message: 'card declined' }))).toBe(false);
    expect(isControlFlowSignal(new Error('deadlock found'))).toBe(false);
  });
});
