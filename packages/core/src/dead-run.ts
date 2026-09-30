import { RUN_ENDED_BEFORE_TOOL_CALL } from './dangling-tool-calls.js';
import type { AgentStore } from './spi/agent-store.js';
import { releaseThreadRun } from './spi/chat-queue.js';

/** The `code` a decision answers with when the run it was for is over (`409`). */
export const RUN_NOT_ACTIVE_CODE = 'run_not_active';

/** What a person is told when they decide on a request whose run is over. */
export const RUN_NOT_ACTIVE_MESSAGE =
  'This request is no longer waiting for an answer: the turn it belonged to has ended. Send the message again.';

/** What is written on the row of a run that was found over without having said so itself. */
export const RUN_NO_LONGER_RUNNING = 'the run is no longer running';

export interface SettleDeadRunInput {
  runId: string;
  /** Set for a thread's own turn: the thread is released if this run still holds it. */
  threadId?: string;
  /**
   * Settle the run ROW as `failed` with this. Pass it only where the caller KNOWS the run failed
   * (the run's own body, unwinding). `recordRunEnd` is last-write-wins, so a caller that only knows
   * the run is no longer running — it may have completed — must leave the row alone.
   */
  failure?: { code: string; message: string };
}

/**
 * Leave nothing waiting on a run that is over and did not say so itself.
 *
 * A run normally settles its own row, its calls and its thread from inside its body. One that is
 * refused a checkpoint position, or whose worker died, never gets there: a call it had put to a
 * person stays `pending_approval` — an approval card that takes a "yes" and then does nothing, for
 * ever — and its thread stays pointed at it. Everything here is written straight to the store,
 * outside any checkpoint, because the callers are exactly the paths that have no journal left to
 * write to; each write is idempotent (only still-pending calls, a release conditional on the
 * holder), so doing it twice changes nothing.
 *
 * Best-effort on purpose: this runs while something else is already failing, and must not replace
 * that failure with one of its own.
 */
export async function settleDeadRun(store: AgentStore, input: SettleDeadRunInput): Promise<void> {
  const failure = input.failure;
  if (failure !== undefined) {
    await Promise.resolve(
      store.recordRunEnd?.({
        runId: input.runId,
        status: 'failed',
        errorCode: failure.code,
        errorMessage: failure.message,
      }),
    ).catch(() => undefined);
  }
  await Promise.resolve(
    store.failUnsettledToolCalls?.(input.runId, RUN_ENDED_BEFORE_TOOL_CALL),
  ).catch(() => 0);
  if (input.threadId !== undefined) {
    await releaseThreadRun(store, input.threadId, input.runId).catch(() => undefined);
  }
}
