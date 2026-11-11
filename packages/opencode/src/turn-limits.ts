import type { AgentRunInput } from '@dudousxd/nestjs-agent-core';
import type { TurnOutcome } from './turn.js';

/** Why a turn was stopped by one of its {@link OpenCodeTurnLimits}. */
export type OpenCodeStopReason = 'steps' | 'compactions' | 'wall-clock';

/**
 * Bounds on one turn, counted from OpenCode's own events for the turn's session. Every bound is
 * optional; a turn without any runs until OpenCode ends it (or `turnTimeoutMs`). The counts are
 * what the turn may do: a limit of N allows N, and the one after stops the turn.
 */
export interface OpenCodeTurnLimits {
  /** Model rounds (`session.step.started`) the turn may run; the round after the last stops it. */
  steps?: number;
  /** Compactions (`session.compaction.started`) the turn may run; the one after the last stops it. */
  compactions?: number;
  /**
   * Milliseconds from the turn's start (its `begin`) to stop at, time parked on a person included.
   * A limit that passes while the turn is parked lands as soon as it observes OpenCode again.
   */
  wallClockMs?: number;
}

/** What the turn had done when it was stopped. */
export interface OpenCodeTurnCounts {
  steps: number;
  compactions: number;
  elapsedMs: number;
}

/**
 * A stop that landed on a turn: one of the limits, or the reason the app gave
 * {@link OpenCodeTurns.stopTurn}. On the turn's outcome (`OpenCodeRunResult.outcome.stop`), on
 * `onTurnEnd`, and on the durable workflow's result.
 */
export interface OpenCodeTurnStop {
  reason: OpenCodeStopReason | (string & {});
  counts: OpenCodeTurnCounts;
}

/**
 * What a stop did:
 *
 * - `aborted`: the session was aborted; the turn ends failed with `outcome.stop` (code `opencode_stopped`).
 * - `settling`: the answer was already settling; it is kept, and `outcome.stop` still reports the stop.
 * - `pending`: the turn is parked on a person; the stop lands when it observes OpenCode again.
 * - `ignored`: the turn has ended, is not executed in this process (any more), no longer owns its
 *   session, the thread's store says another run holds the thread, or the turn was already stopped.
 * - `unconfirmed`: the thread's store could not be read, so nothing was aborted (the abort could
 *   have landed on the thread's next turn). Ask again.
 */
export type OpenCodeStopResult = 'aborted' | 'settling' | 'pending' | 'ignored' | 'unconfirmed';

/**
 * How a turn ended for the process that executed it: its outcome when it settled here, or
 * `released` when this process stopped executing it without it ending here (another worker took
 * the run over, or this process shut down).
 */
export type OpenCodeTurnEndStatus = TurnOutcome['status'] | 'released';

/**
 * Lifecycle hooks of a turn, always called in the process that executes the turn's steps (with
 * `openCodeDurable()`, the worker that runs them, which may not be the one that admitted the
 * question). They carry ids and event types only, never prompts, tool input or output. Errors are
 * logged and never fail the turn. Only `onTurnStart` is waited for, at most `hookTimeoutMs`.
 *
 * Every process that gets `onTurnStart` for a turn gets exactly one `onTurnEnd` for it.
 */
export interface OpenCodeTurnHooks {
  /**
   * This process starts executing the turn: its `begin`, or (`resumed: true`) a later step after the
   * run moved here — a crash, a run resumed elsewhere after a person answered.
   */
  onTurnStart?(event: {
    turnId: string;
    threadId: string;
    sessionId: string;
    resumed: boolean;
  }): void | Promise<void>;
  /** One OpenCode event of the turn's own session: its type and the session, nothing else. */
  onTurnEvent?(event: { turnId: string; type: string; sessionId: string }): void;
  /** A stop landed on the turn (a limit, or `stopTurn`): revoke what it holds, record it. */
  onStop?(event: {
    turnId: string;
    reason: OpenCodeTurnStop['reason'];
    counts: OpenCodeTurnCounts;
  }): void | Promise<void>;
  /**
   * This process is done with the turn: it settled here (`succeeded`, `failed`, `interrupted`), it
   * was cancelled while parked here (`interrupted`), or this process let it go (`released`: another
   * worker took it over, or shutdown). `stop` is set when a stop landed on it and is on its outcome.
   */
  onTurnEnd?(event: {
    turnId: string;
    status: OpenCodeTurnEndStatus;
    stop?: OpenCodeTurnStop;
  }): void | Promise<void>;
}

/** The limits as an option: fixed, or per turn. */
export type OpenCodeTurnLimitsOption =
  | OpenCodeTurnLimits
  | ((input: AgentRunInput) => OpenCodeTurnLimits | undefined);

/** The error code a stopped turn's run row and stream failure carry. */
export const STOPPED_ERROR_CODE = 'opencode_stopped';

/** The text a stopped turn fails with when the host does not word it (`beforeSettle`). */
export function stopErrorText(stop: OpenCodeTurnStop): string {
  switch (stop.reason) {
    case 'steps':
      return `The turn was stopped after ${stop.counts.steps - 1} steps, its limit.`;
    case 'compactions':
      return `The turn was stopped after ${stop.counts.compactions - 1} compactions, its limit.`;
    case 'wall-clock':
      return 'The turn was stopped: it ran longer than allowed.';
    default:
      return 'The turn was stopped.';
  }
}

/** The finite, non-negative bounds of `limits`; anything else is dropped. */
export function cleanLimits(limits: OpenCodeTurnLimits | undefined): OpenCodeTurnLimits {
  const ok = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0;
  return {
    ...(ok(limits?.steps) ? { steps: limits.steps } : {}),
    ...(ok(limits?.compactions) ? { compactions: limits.compactions } : {}),
    ...(ok(limits?.wallClockMs) ? { wallClockMs: limits.wallClockMs } : {}),
  };
}
