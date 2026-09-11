/**
 * The ceiling on how much of a thread rides into a turn. Without one, `runAgentLoop` maps EVERY
 * message the store returns into the model's messages, so a long-lived thread grows until the
 * provider rejects the request — and every turn before that one pays for the whole transcript.
 * `@dudousxd/nestjs-agent-core` ships `windowHistory` as the built-in; anything satisfying this SPI
 * works. Wire it as `AgentLoopDeps.historyPolicy`, or via `AgentModule.forRoot({ history })` /
 * `@Agent({ history })`.
 */

import type { Actor, MessageUsage, ModelMessage } from '../types.js';

/** Whose history this is — enough for a policy to size the window per agent or per actor. */
export interface HistoryPolicyContext {
  threadId: string;
  actor: Actor;
  /** The agent running this turn. Undefined → the default agent. */
  agentName?: string;
}

/** How a policy split the thread: what rides into the turn, and what the ceiling left out. */
export interface HistorySelection {
  /** Sent to the model, oldest-first. */
  keep: ModelMessage[];
  /** Left out, oldest-first. Folded into a leading summary when the policy implements `summarize`. */
  drop: ModelMessage[];
}

/** A stand-in for the messages a window left out, plus what producing it cost. */
export interface HistorySummary {
  /** Prose the loop folds into the window as a leading `system` message. */
  text: string;
  /**
   * What the summarizer spent, when it called a model. Recorded as a `history_summary` usage row, so
   * a ceiling on context cost cannot itself become spend nothing accounts for. Omit for a summarizer
   * that calls no model (a rollup of tool names, a digest the app already stored).
   */
  usage?: MessageUsage;
  /** Accounting label for the model that produced it; falls back to `AgentLoopDeps.modelId`. */
  modelId?: string;
}

export interface HistoryPolicy {
  /**
   * The most messages {@link select} can ever keep, where the ceiling can be stated as a row count.
   *
   * A hint the loop hands to the store, which then reads that many of the thread's newest rows
   * rather than its whole transcript (see `ThreadTurnReader`). Declaring it is a PROMISE about
   * `select`: that it keeps at most this many messages, and that they are the NEWEST ones — so a
   * window of this size is indistinguishable, to `select`, from the full transcript. A policy that
   * can keep more than this, or can keep something older than the newest `maxMessages`, must omit it
   * rather than select over rows the store was never asked for.
   *
   * Omit where the ceiling is not a row count at all — a token budget alone cannot name one, since
   * one message can be four tokens or forty thousand. Omitting costs only the bound on the READ; the
   * prompt is identical either way.
   */
  readonly maxMessages?: number;
  /**
   * Decide what the model sees.
   *
   * MUST be a pure function of `messages`. The loop calls it INSIDE the `load:thread` checkpoint and
   * records its result there, so the ceiling bounds the journal as well as the prompt: what the
   * checkpoint holds is the selection rather than the store's whole `ThreadDetail`, on a payload
   * every replay re-reads. It still adds no position of its own — a policy cannot change the name or
   * position of a single existing checkpoint.
   *
   * Read a clock, a feature flag or a database here and the resumed run windows differently from the
   * one that suspended: the model gets a different prompt, and any step whose existence depends on
   * the split lands at a position the history has no room for. Anything non-deterministic belongs in
   * {@link summarize}, which has a checkpoint of its own.
   *
   * The newest message must always be in `keep` — dropping it leaves the turn with nothing to answer.
   */
  select(messages: ModelMessage[], ctx: HistoryPolicyContext): HistorySelection;
  /**
   * Fold the dropped messages into prose the model reads in their place, prepended to the window as
   * a `system` message. Optional — without it, dropped messages are simply gone, and `load:thread`
   * does not record them either: a summarizer is the only thing that ever reads them back.
   *
   * Runs inside the loop's `history:summarize` checkpoint, so it may call a model or hit the
   * network: the first attempt's result is journaled and every replay reads it back instead of
   * re-summarizing. It runs once per RUN (not per model step), and only when `select` actually
   * dropped something.
   */
  summarize?(dropped: ModelMessage[], ctx: HistoryPolicyContext): Promise<HistorySummary>;
}

/**
 * The window an agent asks for declaratively — `AgentModule.forRoot({ history })` and
 * `@Agent({ history })`. Plain data, so it can live in a decorator's metadata; the NestJS layer
 * turns it into a `windowHistory` policy. A consumer needing anything the window can't express
 * supplies a {@link HistoryPolicy} instead.
 */
export interface AgentHistoryWindow {
  /** Keep at most this many of the newest messages. */
  maxMessages?: number;
  /** Keep the newest messages whose estimated tokens fit this budget. */
  maxTokens?: number;
  /** Fold what the window left out into a leading summary — one extra model call per run. */
  summarize?: boolean;
}
