/**
 * A read-model over the persisted agent data (usage ⋈ pricing, tool calls, threads) for the
 * governance surfaces — the standalone `-dashboard` SPA and the `-telescope` "Agent" tab both
 * consume this ONE interface, so cost/usage aggregation lives in a single place.
 *
 * Separate from {@link AgentStore} on purpose: that SPI owns the write/thread path, this owns the
 * read/analytics path. A store adapter implements both. Consumers inject via
 * `AGENT_GOVERNANCE_QUERIES`.
 *
 * Live activity (in-flight runs, streaming tool calls, delegations, forbidden attempts) is NOT here
 * — that comes off the `aviary:agent:*` diagnostics channel. This interface is the durable, restart-
 * surviving history.
 */

/** Inclusive UTC day range, each `YYYY-MM-DD`. */
export interface GovernanceRange {
  fromDay: string;
  toDay: string;
}

/** Spend + token totals for one model over a range. */
export interface ModelSpendRow {
  modelId: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** Spend + token totals for one acting ref (user/tenant) over a range. */
export interface ActorSpendRow {
  actorRef: string;
  requests: number;
  totalTokens: number;
  costUsd: number;
  /** Distinct threads the actor used in the range. */
  threadCount: number;
}

/** Spend + token totals for one thread over a range. */
export interface ThreadSpendRow {
  threadId: string;
  title: string;
  actorRef: string;
  requests: number;
  totalTokens: number;
  costUsd: number;
}

/** One point on the daily usage/cost trend. */
export interface UsageTrendPoint {
  day: string;
  totalTokens: number;
  costUsd: number;
}

/** A recent tool-call for the activity feed. */
export interface ToolCallActivityRow {
  toolCallId: string;
  toolName: string;
  toolType: string;
  status: string;
  threadId: string;
  createdAt: string;
  /** The run this call belongs to, for a trace deep-link; `null` for a call recorded before this shipped. */
  runId: string | null;
}

/** A recent thread with rolled-up activity. */
export interface ThreadActivityRow {
  threadId: string;
  title: string;
  actorRef: string;
  messageCount: number;
  totalTokens: number;
  lastActivityAt: string;
}

/** Aggregated run reliability over a range. */
export interface RunMetrics {
  runs: number;
  completed: number;
  failed: number;
  /** completed / runs, 0 when runs = 0. */
  successRate: number;
  /** Total llm-step retries across the range's runs. */
  retries: number;
  durationP50Ms: number | null;
  durationP95Ms: number | null;
}

/** Run/failure/retry rollup for one agent over a range. */
export interface RunAgentBreakdownRow {
  /** '(default)' when the run had none. */
  agentName: string;
  runs: number;
  failed: number;
  retries: number;
}

/** Failed-run count for one error code over a range. */
export interface RunErrorBreakdownRow {
  errorCode: string;
  count: number;
}

/** One point on the daily run/failure trend. */
export interface RunTrendPoint {
  day: string;
  runs: number;
  failed: number;
}

/** A recent run for the reliability feed. */
export interface RecentRunRow {
  runId: string;
  threadId: string;
  actorRef: string;
  agentName: string | null;
  /** 'running' | 'completed' | 'failed'. */
  status: string;
  durationMs: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  retries: number;
  /** ISO timestamp. */
  startedAt: string;
  /** sha256 hex of the run's resolved (pre-RAG) system prompt; `null` for a run recorded before this shipped. */
  promptHash: string | null;
}

/** One tool call awaiting a HITL decision, for the cross-thread approvals inbox. */
export interface PendingApprovalRow {
  toolCallId: string;
  toolName: string;
  input: unknown;
  threadId: string;
  threadTitle: string;
  /** Who asked — the run's actor. */
  actorRef: string;
  agentName: string | null;
  /** ISO timestamp. */
  requestedAt: string;
  /** The run this call belongs to, for a trace deep-link; `null` for a call recorded before this shipped. */
  runId: string | null;
}

/** Governance rollup for one tool over a range. */
export interface ToolStatRow {
  toolName: string;
  toolType: string;
  calls: number;
  failed: number;
  rejected: number;
  /**
   * p50 (median) of executionMs across calls that recorded one; null when none carry it. Reported
   * alongside p95 rather than a mean: tool latency is long-tailed (a retry or a slow upstream drags
   * an average somewhere no single call ever was), so the pair "typical / tail" is what an operator
   * can actually act on.
   */
  p50ExecutionMs: number | null;
  /** p95 of executionMs across executed calls; null when none carry it. */
  p95ExecutionMs: number | null;
}

/**
 * Neutral paged query for the governance list reads (`toolCallsPage`/`threadsPage`/`runsPage`). The
 * WIRE format a host exposes over HTTP mirrors `@dudousxd/nestjs-filter`'s conventions (`page`,
 * `limit`, `where[field][op]`) so consumers see one grammar across the ecosystem, but this SPI stays
 * neutral/typed — no filter-builder or ORM coupling here.
 */
export interface GovernancePageQuery<TWhere> {
  /** 1-based. */
  page: number;
  /** Rows per page, already clamped by the caller (the dashboard clamps to 200). */
  pageSize: number;
  /** Equality/range filters; absent field = no constraint. */
  where?: TWhere;
}

/** One page of a governance list read, with the total row count for prev/next + "page X of Y" UI. */
export interface GovernancePage<TRow> {
  rows: TRow[];
  total: number;
  page: number;
  pageSize: number;
}

/** Filters for {@link AgentGovernanceQueries.toolCallsPage}. */
export interface ToolCallWhere {
  toolName?: string;
  toolType?: string;
  status?: string;
  threadId?: string;
  /** Inclusive UTC day bounds, `YYYY-MM-DD`. */
  fromDay?: string;
  toDay?: string;
}

/** Filters for {@link AgentGovernanceQueries.threadsPage}. */
export interface ThreadWhere {
  actorRef?: string;
  /** Substring match on the title (case-insensitive). */
  title?: string;
  fromDay?: string;
  toDay?: string;
}

/** Filters for {@link AgentGovernanceQueries.runsPage}. */
export interface RunWhere {
  agentName?: string;
  status?: string;
  errorCode?: string;
  threadId?: string;
  fromDay?: string;
  toDay?: string;
}

/** Filters for {@link AgentGovernanceQueries.approvalsPage}. */
export interface ApprovalWhere {
  toolName?: string;
  threadId?: string;
  /** The requesting thread's owner. */
  actorRef?: string;
  agentName?: string;
  /** Inclusive UTC day bounds on when the approval was requested, `YYYY-MM-DD`. */
  fromDay?: string;
  toDay?: string;
}

// ─── Drill-down details ──────────────────────────────────────────────────────
//
// The list reads above answer "what happened"; these two answer "what happened HERE". Each is ONE
// call returning everything the corresponding drill-down renders, so a console never fans out a
// query per row it just drew. Both return `null` for an id that doesn't exist — the caller decides
// whether that's a 404 or an empty panel.

/** One tool call inside a {@link GovernanceRunDetail}, with the execution outcome a list row can't afford to carry. */
export interface RunToolCallRow {
  toolCallId: string;
  toolName: string;
  toolType: string;
  status: string;
  /** Wall time of the execution; null for a call that never executed (rejected/still pending). */
  executionMs: number | null;
  /** Who executed/decided it, when the store recorded an attribution. */
  executedByRef: string | null;
  /** The failure text for a `failed` call; null otherwise. */
  error: string | null;
  /** ISO timestamp. */
  createdAt: string;
}

/** The owning thread's headline, carried on a drill-down so it can be named without a second read. */
export interface DetailThreadRef {
  threadId: string;
  title: string;
  actorRef: string;
  /** True when the thread is soft-deleted — its history is still readable, the thread is not. */
  deleted: boolean;
}

/**
 * Everything a run drill-down renders: the run row itself, its owning thread's headline, and the
 * tool calls attributed to it.
 *
 * `toolCalls` is empty for a run recorded before tool calls carried a `runId` (the column is
 * nullable and pre-rollout rows have none) — indistinguishable, from here, from a run that called
 * no tools. There is deliberately no cost figure: the token ledger has no run column, so per-run
 * spend is not attributable without a store migration.
 */
export interface GovernanceRunDetail {
  run: RecentRunRow;
  thread: DetailThreadRef;
  /** The run's tool calls, oldest first — the order they were requested in. */
  toolCalls: RunToolCallRow[];
}

/** One message inside a {@link GovernanceThreadDetail}. `content` is capped server-side. */
export interface ThreadMessageRow {
  messageId: string;
  role: string;
  /** Message text, cut to {@link THREAD_DETAIL_CONTENT_CHARS}; see `truncated`. */
  content: string;
  /** True when `content` was cut — the console shows an explicit "…" rather than implying the tail. */
  truncated: boolean;
  agentName: string | null;
  /** How many tool calls this message requested. */
  toolCallCount: number;
  /** ISO timestamp. */
  createdAt: string;
}

/** Token/cost rollup across a thread's whole ledger (not range-scoped — a thread's lifetime). */
export interface ThreadUsageRollup {
  /** Ledger rows, i.e. billed turns. */
  requests: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  costUsd: number;
}

/** Everything a thread drill-down renders, in one call. */
export interface GovernanceThreadDetail {
  /** The thread's own activity row (`messageCount` is the thread total, not the page below). */
  thread: ThreadActivityRow;
  /** True when the thread is soft-deleted. */
  deleted: boolean;
  usage: ThreadUsageRollup;
  /** The thread's runs, newest first, capped at the query's `runLimit`. */
  runs: RecentRunRow[];
  /** Runs on this thread in total — `runs.length < runTotal` means the cap bit. */
  runTotal: number;
  /** The thread's messages, newest first, capped at the query's `messageLimit`. */
  messages: ThreadMessageRow[];
}

/** Row caps for {@link AgentGovernanceQueries.threadDetail}, already clamped by the caller. */
export interface GovernanceThreadDetailQuery {
  threadId: string;
  /** Max messages returned, newest first. */
  messageLimit: number;
  /** Max runs returned, newest first. */
  runLimit: number;
}

/**
 * Per-message content cap for {@link ThreadMessageRow.content}. A drill-down is a triage view, not a
 * transcript reader: capping here keeps one response bounded regardless of how long an assistant
 * turn ran. Shared by every adapter so the cut is identical wherever the console is served from.
 */
export const THREAD_DETAIL_CONTENT_CHARS = 2000;

/**
 * Cut a message body to {@link THREAD_DETAIL_CONTENT_CHARS}, reporting whether it was cut. Lives
 * next to the cap so every adapter truncates at the same boundary — a console comparing two stores
 * must not see two different "…".
 */
export function truncateDetailContent(content: string): {
  content: string;
  truncated: boolean;
} {
  if (content.length <= THREAD_DETAIL_CONTENT_CHARS) {
    return { content, truncated: false };
  }
  return { content: content.slice(0, THREAD_DETAIL_CONTENT_CHARS), truncated: true };
}

/**
 * The governance read-model. Cost is `inputTokens/1e6 * inputPricePer1m + outputTokens/1e6 *
 * outputPricePer1m` against the current pricing row per model; an unpriced model contributes 0 cost
 * (its tokens still count).
 */
export interface AgentGovernanceQueries {
  spendByModel(range: GovernanceRange): Promise<ModelSpendRow[]>;
  spendByActor(range: GovernanceRange): Promise<ActorSpendRow[]>;
  /** Top threads by spend within the range, highest cost first, capped at `limit`. */
  spendByThread(range: GovernanceRange, limit: number): Promise<ThreadSpendRow[]>;
  usageTrend(range: GovernanceRange): Promise<UsageTrendPoint[]>;
  recentToolCalls(limit: number): Promise<ToolCallActivityRow[]>;
  recentThreads(limit: number): Promise<ThreadActivityRow[]>;
  // Run reliability. An adapter backed by a store without run recording (no `recordRunStart`)
  // returns zeros/empty from all five (plus `runsPage`, below) — the dashboard renders an empty
  // reliability surface.
  runMetrics(range: GovernanceRange): Promise<RunMetrics>;
  runsByAgent(range: GovernanceRange): Promise<RunAgentBreakdownRow[]>;
  runErrors(range: GovernanceRange): Promise<RunErrorBreakdownRow[]>;
  runTrend(range: GovernanceRange): Promise<RunTrendPoint[]>;
  recentRuns(limit: number): Promise<RecentRunRow[]>;
  /**
   * Tool calls sitting `pending_approval`, oldest first — an inbox drains from the back. Capped at
   * `limit`, with NO total: a caller that needs to know whether the cap hid anything wants
   * {@link approvalsPage} instead.
   */
  pendingApprovals(limit: number): Promise<PendingApprovalRow[]>;
  /**
   * Paged, filterable approvals inbox, oldest first (same ordering as `pendingApprovals`). Unlike
   * that method this reports `total`, so a console can page a backlog and say how much of it is
   * off-screen — the one failure this surface cannot afford is a pending approval nobody sees.
   * An adapter without the backing data returns an empty page (`total: 0`) rather than throwing.
   */
  approvalsPage(
    query: GovernancePageQuery<ApprovalWhere>,
  ): Promise<GovernancePage<PendingApprovalRow>>;
  /** Per-tool call/failure/rejection/latency rollup over the range, highest call count first. */
  toolStats(range: GovernanceRange): Promise<ToolStatRow[]>;
  /**
   * Paged, filterable tool-call activity, newest-first (same ordering as `recentToolCalls`). An
   * adapter without the backing data returns an empty page (`total: 0`) rather than throwing.
   */
  toolCallsPage(
    query: GovernancePageQuery<ToolCallWhere>,
  ): Promise<GovernancePage<ToolCallActivityRow>>;
  /**
   * Paged, filterable thread activity, newest-first (same ordering as `recentThreads`). An adapter
   * without the backing data returns an empty page (`total: 0`) rather than throwing.
   */
  threadsPage(query: GovernancePageQuery<ThreadWhere>): Promise<GovernancePage<ThreadActivityRow>>;
  /**
   * Paged, filterable run activity, newest-first (same ordering as `recentRuns`). An adapter backed
   * by a store without run recording (no `recordRunStart`) returns an empty page (`total: 0`).
   */
  runsPage(query: GovernancePageQuery<RunWhere>): Promise<GovernancePage<RecentRunRow>>;
  /**
   * One run with its owning thread and its tool calls — the drill-down behind a row in the runs
   * table. `null` when no run has that id. ONE call, not one per tool call: a failed run is the
   * thing an operator opens first and it should not cost a query per step.
   *
   * An adapter backed by a store without run recording returns `null` for every id.
   */
  runDetail(runId: string): Promise<GovernanceRunDetail | null>;
  /**
   * One thread with its lifetime usage rollup, its recent runs and its recent messages — the
   * drill-down behind a row in the threads table. `null` when no thread has that id; a soft-deleted
   * thread IS returned (with `deleted: true`), because "what did the thread we just deleted do" is
   * exactly the question an audit asks.
   */
  threadDetail(query: GovernanceThreadDetailQuery): Promise<GovernanceThreadDetail | null>;
}
