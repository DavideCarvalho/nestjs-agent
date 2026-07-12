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
  /** Tool calls sitting `pending_approval`, oldest first — an inbox drains from the back. Capped at `limit`. */
  pendingApprovals(limit: number): Promise<PendingApprovalRow[]>;
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
}
