/**
 * The durable runtime's marker for a CONTROL-FLOW signal — a suspend or a continue-as-new, thrown to
 * unwind the current turn, never a failure. Declared here as a bare `Symbol.for` rather than
 * imported, for the same reason `replay-integrity.ts` matches by name: core depends on neither
 * durable package and must not, since the inline runner has to work with neither installed. The
 * duplication is safe precisely because the key is in the GLOBAL registry — the string IS the
 * contract, and a locally-declared copy collapses onto the identical symbol across duplicate module
 * copies, dual ESM/CJS loads, and the two packages that raise these signals under different class
 * names (`@dudousxd/nestjs-durable-core`'s `WorkflowSuspended`/`ContinueAsNew`, the BullMQ thin
 * worker's `Suspend`).
 */
const CONTROL_FLOW_SIGNAL = Symbol.for('aviary:durable:control-flow');

/**
 * Is this the runner unwinding the turn (a durable suspend / continue-as-new) rather than something
 * the agent did? Callers must rethrow it untouched: every `catch` in the loop reacts by writing more
 * checkpoints, and a suspend recorded as a tool failure leaves a journal the resumed replay cannot
 * line up with.
 *
 * Detected from the error itself so a host that never wired `AgentLoopHooks.isControlFlowError` still
 * gets its suspends through — that hook is an override for a runner whose signals carry no marker,
 * not the only line of defence. Checked as a stamped property, NOT `instanceof`: the classes differ
 * per runtime, which is why the marker exists.
 */
export function isControlFlowSignal(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { [CONTROL_FLOW_SIGNAL]?: unknown })[CONTROL_FLOW_SIGNAL] === true
  );
}
