/**
 * The evaluation SPI: a {@link Scorer} turns ONE stored run into a number plus the sentence that
 * justifies it. Everything else in this package (the batch runner, the score store, the summaries)
 * is plumbing around that one call.
 *
 * Scoring is offline-first. A {@link ScorableRun} is assembled from what the agent already
 * persisted — the run row, the transcript, the tool calls and their HITL outcomes — so a scorer
 * never sits inside a turn, never adds latency to it, and can be re-run over history the day a new
 * scorer is written.
 */

/** One tool call the run made, reduced to what a scorer can judge. */
export interface ScorableToolCall {
  toolCallId: string;
  toolName: string;
  /** `'read'` (auto-executed) or `'action'` (only an `action` carries a human decision). */
  toolType: string;
  /** A {@link import('@dudousxd/nestjs-agent-core').ToolCallStatus} as the store recorded it. */
  status: string;
  /** Wall time of the execution; `null` for a call that never executed. */
  executionMs: number | null;
  /** The failure text for a `failed` call; `null` otherwise. */
  error: string | null;
}

/** One stored run, flattened into the unit a scorer judges. */
export interface ScorableRun {
  runId: string;
  threadId: string;
  actorRef: string;
  agentName: string | null;
  /**
   * `'running'` | `'completed'` | `'failed'` | `'cancelled'`, as the store recorded it. `cancelled`
   * is a terminal of its own — a user pressing Stop — so a scorer that reads this must not fold it
   * into the failure count.
   */
  status: string;
  /** The user text that opened the turn; `''` when the transcript could not supply one. */
  input: string;
  /** The assistant text the turn produced; `''` when the run answered nothing. */
  output: string;
  toolCalls: ScorableToolCall[];
  durationMs: number | null;
  /** Stable failure slug for a failed run; `null` otherwise. */
  errorCode: string | null;
  /** ISO timestamp the run started — the day a score is bucketed under. */
  startedAt: string;
}

/**
 * Which family a scorer belongs to, kept on the persisted score so a summary can separate a free
 * deterministic signal from one that cost money to produce.
 *
 * - `rule`        — deterministic, derived from the run alone (no corpus, no model).
 * - `statistical` — an estimate over a corpus of past runs (frequencies, priors).
 * - `model`       — LLM-as-judge: another model call, therefore the expensive family.
 */
export type ScorerKind = 'rule' | 'statistical' | 'model';

/** One scorer's verdict on one run. */
export interface ScoreResult {
  /** Normalized to `0..1`, where 1 is good. A scorer that cannot honour that range is a bug. */
  score: number;
  /** Why THAT number, in one sentence — the thing an operator reads before the number. */
  reason: string;
  /** Scorer-specific detail (counts, per-tool breakdowns) persisted alongside the score. */
  metadata?: Record<string, unknown>;
}

/**
 * A quality signal over a stored run.
 *
 * `score` returns `null` for a run the scorer has nothing to say about — an approval scorer facing
 * a run that proposed no action, a judge facing an empty answer. That is deliberately NOT a 0: a
 * score of 0 says "bad", `null` says "not applicable", and averaging the two together is how a
 * quality metric silently stops meaning anything.
 */
export interface Scorer {
  /** Stable identifier, persisted on every score row and used to resume a backfill. */
  name: string;
  kind: ScorerKind;
  score(run: ScorableRun): Promise<ScoreResult | null>;
}

/** Clamp a computed score into the `0..1` range {@link ScoreResult.score} promises. */
export function clampScore(value: number): number {
  return Math.min(1, Math.max(0, value));
}
