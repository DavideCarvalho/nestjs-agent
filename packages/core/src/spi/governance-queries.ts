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

/**
 * The governance read-model. Cost is `inputTokens/1e6 * inputPricePer1m + outputTokens/1e6 *
 * outputPricePer1m` against the current pricing row per model; an unpriced model contributes 0 cost
 * (its tokens still count).
 */
export interface AgentGovernanceQueries {
  spendByModel(range: GovernanceRange): Promise<ModelSpendRow[]>;
  spendByActor(range: GovernanceRange): Promise<ActorSpendRow[]>;
  usageTrend(range: GovernanceRange): Promise<UsageTrendPoint[]>;
  recentToolCalls(limit: number): Promise<ToolCallActivityRow[]>;
  recentThreads(limit: number): Promise<ThreadActivityRow[]>;
}
