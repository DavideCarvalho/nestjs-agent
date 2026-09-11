/**
 * Is this the durable runtime refusing a checkpoint position, rather than anything the agent did?
 *
 * Matched by NAME because this package cannot import either class: the in-process engine throws
 * `@dudousxd/nestjs-durable-core`'s `NonDeterminismError` and the thin BullMQ worker throws
 * `@dudousxd/nestjs-durable-worker`'s `NondeterminismError` — the same contract under two spellings
 * in two packages, neither of which core depends on. Same cross-runtime reasoning as the
 * `isControlFlowError` hook, which exists for exactly this reason on the suspend path.
 *
 * Suffix rather than equality, because a runtime is free to qualify the name: the sibling Adonis
 * stack raises a `WorkflowNondeterminismError` from its remote-replay path, which an equality check
 * would wave through as an ordinary tool failure. `replay-integrity.contract.spec.ts` pins this
 * against the real exported classes, so a rename upstream fails a test instead of quietly
 * disarming the guard.
 *
 * Callers must let these through untouched. Every `catch` in a workflow body reacts by writing more
 * checkpoints (a toolfail, a run-end, a deactivate), and on a journal that has already diverged each
 * of those asks for a position the history cannot supply — so the recovery attempt raises its own
 * refusal, and THAT is the error the operator reads: a message pointing at the wrong seq, naming
 * checkpoints from the recovery path rather than the two that actually disagreed.
 */
export function isReplayIntegrityError(error: unknown): boolean {
  return error instanceof Error && error.name.toLowerCase().endsWith('nondeterminismerror');
}
