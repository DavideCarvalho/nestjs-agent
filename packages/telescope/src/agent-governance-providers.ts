import type {
  ActorSpendRow,
  AgentGovernanceQueries,
  GovernanceRange,
  ModelSpendRow,
  PendingApprovalRow,
  RecentRunRow,
  RunAgentBreakdownRow,
  RunErrorBreakdownRow,
  RunMetrics,
  RunTrendPoint,
  ThreadActivityRow,
  ThreadSpendRow,
  ToolCallActivityRow,
  ToolStatRow,
  UsageTrendPoint,
} from '@dudousxd/nestjs-agent-core';
import { AGENT_GOVERNANCE_QUERIES } from '@dudousxd/nestjs-agent-core';
import type { DataProvider, ExtensionContext } from '@dudousxd/nestjs-telescope';

/**
 * Governance data providers for the "Agent" Telescope tab: spend/usage, run reliability, tool
 * activity, and the cross-thread approvals inbox. Unlike the live watcher-fed providers in
 * `agent-data-providers.ts` (which read the ephemeral Telescope event storage), these read the
 * authoritative, restart-surviving read-model: `AGENT_GOVERNANCE_QUERIES` (usage ⋈ pricing, plus
 * run/tool-call/thread history).
 *
 * The read-model is resolved from the host's DI container via `ctx.moduleRef` — the exact same
 * mechanism the existing providers use for `TELESCOPE_STORAGE`. The host must bind
 * `AGENT_GOVERNANCE_QUERIES` (from its store adapter) in the same module that registers Telescope;
 * when the binding is absent every provider degrades to an empty-but-valid shape rather than throwing.
 */

/** Default trailing window (in days, inclusive) when a panel query omits an explicit range. */
const DEFAULT_TREND_WINDOW_DAYS = 30;

const ISO_DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** A breakdown-panel segment (Telescope core: `{ segments: Array<{ label, value, color? }> }`). */
interface BreakdownSegment {
  label: string;
  value: number;
}

/** One row of the per-model usage/cost table. */
interface ModelSpendTableRow {
  modelId: string;
  requests: number;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

/** One row of the per-actor spend table. */
interface ActorSpendTableRow {
  actorRef: string;
  requests: number;
  totalTokens: number;
  costUsd: number;
}

/** One row of the top-threads-by-cost table. */
interface ThreadSpendTableRow {
  title: string;
  actorRef: string;
  requests: number;
  totalTokens: number;
  costUsd: number;
}

/** Top threads by cost within the range, capped to this count. */
const TOP_THREADS_LIMIT = 10;

/** One point of the timeseries trend (Telescope core: `{ label } & Record<string, number>`). */
interface UsageTrendTableRow {
  label: string;
  costUsd: number;
  totalTokens: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Structural guard so the DI-resolved binding is narrowed without an `as`/`any` cast. */
function isGovernanceQueries(value: unknown): value is AgentGovernanceQueries {
  return (
    isRecord(value) &&
    typeof value.spendByModel === 'function' &&
    typeof value.spendByActor === 'function' &&
    typeof value.spendByThread === 'function' &&
    typeof value.usageTrend === 'function' &&
    typeof value.recentToolCalls === 'function' &&
    typeof value.recentThreads === 'function' &&
    typeof value.runMetrics === 'function' &&
    typeof value.runsByAgent === 'function' &&
    typeof value.runErrors === 'function' &&
    typeof value.runTrend === 'function' &&
    typeof value.recentRuns === 'function' &&
    typeof value.pendingApprovals === 'function' &&
    typeof value.toolStats === 'function'
  );
}

/**
 * Resolve the governance read-model from the host container. Returns `null` when the host has not
 * bound `AGENT_GOVERNANCE_QUERIES` (missing token throws inside `moduleRef.get`) so panels can render
 * an empty state instead of erroring.
 */
function resolveGovernanceQueries(ctx: ExtensionContext): AgentGovernanceQueries | null {
  let resolved: unknown;
  try {
    resolved = ctx.moduleRef.get(AGENT_GOVERNANCE_QUERIES, { strict: false });
  } catch {
    return null;
  }
  return isGovernanceQueries(resolved) ? resolved : null;
}

function isIsoDay(value: unknown): value is string {
  return typeof value === 'string' && ISO_DAY_PATTERN.test(value);
}

function todayUtcDay(): string {
  return new Date().toISOString().slice(0, 10);
}

/** Shift a `YYYY-MM-DD` UTC day by `deltaDays` (negative goes back in time). */
export function shiftUtcDay(day: string, deltaDays: number): string {
  const shifted = new Date(`${day}T00:00:00.000Z`);
  shifted.setUTCDate(shifted.getUTCDate() + deltaDays);
  return shifted.toISOString().slice(0, 10);
}

/**
 * Derive the query range: honour explicit `fromDay`/`toDay` (validated ISO days), otherwise default
 * to the trailing {@link DEFAULT_TREND_WINDOW_DAYS}-day window ending today (UTC).
 */
export function resolveRange(query: Record<string, unknown> | undefined): GovernanceRange {
  const toDay = query && isIsoDay(query.toDay) ? query.toDay : todayUtcDay();
  const fromDay =
    query && isIsoDay(query.fromDay)
      ? query.fromDay
      : shiftUtcDay(toDay, -(DEFAULT_TREND_WINDOW_DAYS - 1));
  return { fromDay, toDay };
}

function roundCents(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Sum authoritative spend across every model row. */
export function totalCostUsd(rows: ModelSpendRow[]): number {
  return roundCents(rows.reduce((sum, row) => sum + row.costUsd, 0));
}

/** Sum input + output tokens across every model row. */
export function totalTokens(rows: ModelSpendRow[]): number {
  return rows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
}

/** Spend-by-model as breakdown segments (models with zero cost are dropped from the donut). */
export function toModelSpendSegments(rows: ModelSpendRow[]): BreakdownSegment[] {
  return rows
    .filter((row) => row.costUsd > 0)
    .map((row) => ({ label: row.modelId, value: roundCents(row.costUsd) }));
}

/** Spend-by-model as table rows (cost rounded to cents; usage kept exact). */
export function toModelSpendRows(rows: ModelSpendRow[]): ModelSpendTableRow[] {
  return rows.map((row) => ({
    modelId: row.modelId,
    requests: row.requests,
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    costUsd: roundCents(row.costUsd),
  }));
}

/** Spend-by-actor as table rows. */
export function toActorSpendRows(rows: ActorSpendRow[]): ActorSpendTableRow[] {
  return rows.map((row) => ({
    actorRef: row.actorRef,
    requests: row.requests,
    totalTokens: row.totalTokens,
    costUsd: roundCents(row.costUsd),
  }));
}

/** Top-threads-by-cost as table rows. */
export function toThreadSpendRows(rows: ThreadSpendRow[]): ThreadSpendTableRow[] {
  return rows.map((row) => ({
    title: row.title || row.threadId,
    actorRef: row.actorRef,
    requests: row.requests,
    totalTokens: row.totalTokens,
    costUsd: roundCents(row.costUsd),
  }));
}

/** Spend-by-actor as breakdown segments (actors with zero cost are dropped). */
export function toActorSpendSegments(rows: ActorSpendRow[]): BreakdownSegment[] {
  return rows
    .filter((row) => row.costUsd > 0)
    .map((row) => ({ label: row.actorRef, value: roundCents(row.costUsd) }));
}

/** Daily usage trend as timeseries rows keyed by `label` (the day). */
export function toUsageTrendRows(points: UsageTrendPoint[]): UsageTrendTableRow[] {
  return points.map((point) => ({
    label: point.day,
    costUsd: roundCents(point.costUsd),
    totalTokens: point.totalTokens,
  }));
}

// ─── Run reliability + tools + approvals shaping ─────────────────────────────

/** Placeholder shown for a table cell whose source value is `null`/unmeasured — matches the
 * convention `@dudousxd/nestjs-durable-telescope` uses for the same case (e.g. `fmtNum`). */
const NO_VALUE = '—';

/** Run/failure/retry rollup as table rows — `RunAgentBreakdownRow` is already table-shaped. */
export function toRunAgentTableRows(
  rows: RunAgentBreakdownRow[],
): Array<{ agentName: string; runs: number; failed: number; retries: number }> {
  return rows.map((row) => ({
    agentName: row.agentName,
    runs: row.runs,
    failed: row.failed,
    retries: row.retries,
  }));
}

/** Failed-run counts by error code as breakdown segments. */
export function toRunErrorSegments(rows: RunErrorBreakdownRow[]): BreakdownSegment[] {
  return rows.map((row) => ({ label: row.errorCode, value: row.count }));
}

/** One point of the run/failure trend (Telescope core: `{ label } & Record<string, number>`). */
interface RunTrendTableRow {
  label: string;
  runs: number;
  failed: number;
}

/** Daily run/failure trend as timeseries rows keyed by `label` (the day). */
export function toRunTrendRows(points: RunTrendPoint[]): RunTrendTableRow[] {
  return points.map((point) => ({ label: point.day, runs: point.runs, failed: point.failed }));
}

/** Cap this many characters before a byte length; matches the DB column's practical display width. */
const ERROR_MESSAGE_CAP = 500;

/**
 * Cap a run's error message to {@link ERROR_MESSAGE_CAP} characters before it leaves the provider.
 * `DataProvider.resolve` output bypasses Telescope core's `redact()` pipeline — that only runs on
 * entries a `Watcher` records via `ctx.record`, not on values a provider computes and returns
 * directly to a panel — so an unbounded stack trace or secret-laden failure message would ride
 * straight into a table cell with no truncation/redaction safety net. This cap is a stopgap
 * mitigation, not a substitute for the (out-of-scope this wave) telescope-core redaction hook for
 * DataProvider output.
 */
export function capErrorMessage(message: string | null): string | null {
  if (message === null) return null;
  return message.length > ERROR_MESSAGE_CAP ? `${message.slice(0, ERROR_MESSAGE_CAP)}…` : message;
}

/** How many leading hex characters of a promptHash the table shows as a short chip. */
const PROMPT_HASH_CHIP_LENGTH = 10;

/** Shorten a full sha256 promptHash to a compact chip for the table column. */
export function shortPromptHash(promptHash: string | null): string | null {
  return promptHash === null ? null : promptHash.slice(0, PROMPT_HASH_CHIP_LENGTH);
}

/** One row of the recent-runs table — every nullable field falls back to {@link NO_VALUE}. */
interface RecentRunTableRow {
  startedAt: string;
  runId: string;
  threadId: string;
  actorRef: string;
  agentName: string;
  status: string;
  durationMs: number | string;
  retries: number;
  errorCode: string;
  errorMessage: string;
  promptHash: string;
}

/** Recent runs as table rows: errorMessage capped, promptHash shortened to a chip. */
export function toRecentRunTableRows(rows: RecentRunRow[]): RecentRunTableRow[] {
  return rows.map((row) => ({
    startedAt: row.startedAt,
    runId: row.runId,
    threadId: row.threadId,
    actorRef: row.actorRef,
    agentName: row.agentName ?? NO_VALUE,
    status: row.status,
    durationMs: row.durationMs ?? NO_VALUE,
    retries: row.retries,
    errorCode: row.errorCode ?? NO_VALUE,
    errorMessage: capErrorMessage(row.errorMessage) ?? NO_VALUE,
    promptHash: shortPromptHash(row.promptHash) ?? NO_VALUE,
  }));
}

/** Recent tool calls as table rows — `ToolCallActivityRow` is already table-shaped. */
export function toRecentToolCallRows(rows: ToolCallActivityRow[]): ToolCallActivityRow[] {
  return rows;
}

/** Recent threads as table rows — `ThreadActivityRow` is already table-shaped. */
export function toRecentThreadTableRows(rows: ThreadActivityRow[]): ThreadActivityRow[] {
  return rows;
}

/** One row of the pending-approvals inbox table, `input` stringified for display. */
interface PendingApprovalTableRow {
  toolCallId: string;
  toolName: string;
  threadId: string;
  threadTitle: string;
  actorRef: string;
  agentName: string;
  requestedAt: string;
}

/** Pending-approvals rows as table rows (drops the raw `input` — not renderable in a table cell). */
export function toPendingApprovalTableRows(rows: PendingApprovalRow[]): PendingApprovalTableRow[] {
  return rows.map((row) => ({
    toolCallId: row.toolCallId,
    toolName: row.toolName,
    threadId: row.threadId,
    threadTitle: row.threadTitle,
    actorRef: row.actorRef,
    agentName: row.agentName ?? NO_VALUE,
    requestedAt: row.requestedAt,
  }));
}

/** One row of the per-tool stats table, `p95ExecutionMs` falling back to {@link NO_VALUE}. */
interface ToolStatTableRow {
  toolName: string;
  toolType: string;
  calls: number;
  failed: number;
  rejected: number;
  p95ExecutionMs: number | string;
}

/** Per-tool call/failure/rejection/latency rollup as table rows. */
export function toToolStatTableRows(rows: ToolStatRow[]): ToolStatTableRow[] {
  return rows.map((row) => ({
    toolName: row.toolName,
    toolType: row.toolType,
    calls: row.calls,
    failed: row.failed,
    rejected: row.rejected,
    p95ExecutionMs: row.p95ExecutionMs ?? NO_VALUE,
  }));
}

/** Zero-valued `RunMetrics`, returned when the read-model isn't bound. */
const EMPTY_RUN_METRICS: RunMetrics = {
  runs: 0,
  completed: 0,
  failed: 0,
  successRate: 0,
  retries: 0,
  durationP50Ms: null,
  durationP95Ms: null,
};

/**
 * Build a governance `DataProvider` from a fetch + a format step. Every provider follows the same
 * shape: resolve the read-model, run ONE query over the panel's range, then format the rows into the
 * panel's result shape. When the host hasn't bound the read-model, `fetch` is skipped and `format`
 * runs over `[]` — which is exactly the empty-but-valid shape each formatter already yields (0 for
 * totals, `[]` for segments/rows), so the degraded case needs no special-casing.
 */
function governanceStatProvider<TRow>(
  name: string,
  fetch: (queries: AgentGovernanceQueries, range: GovernanceRange) => Promise<TRow[]>,
  format: (rows: TRow[]) => unknown,
): DataProvider {
  return {
    name,
    async resolve(query, ctx) {
      const queries = resolveGovernanceQueries(ctx);
      const rows = queries ? await fetch(queries, resolveRange(query)) : [];
      return format(rows);
    },
  };
}

/** stat → authoritative total spend (USD) over the range. */
export function agentSpendTotalProvider(): DataProvider {
  return governanceStatProvider(
    'agent.spend.totalCost',
    (queries, range) => queries.spendByModel(range),
    (rows) => ({ value: totalCostUsd(rows) }),
  );
}

/** stat → authoritative total tokens (input + output) over the range. */
export function agentTokensTotalProvider(): DataProvider {
  return governanceStatProvider(
    'agent.spend.totalTokens',
    (queries, range) => queries.spendByModel(range),
    (rows) => ({ value: totalTokens(rows) }),
  );
}

/** breakdown → spend share per model. */
export function agentSpendByModelProvider(): DataProvider {
  return governanceStatProvider(
    'agent.spend.byModel',
    (queries, range) => queries.spendByModel(range),
    (rows) => ({ segments: toModelSpendSegments(rows) }),
  );
}

/** table → per-model requests / in+out tokens / cost. */
export function agentModelSpendTableProvider(): DataProvider {
  return governanceStatProvider(
    'agent.spend.byModelTable',
    (queries, range) => queries.spendByModel(range),
    (rows) => ({ rows: toModelSpendRows(rows) }),
  );
}

/** timeseries → daily spend + tokens trend. */
export function agentUsageTrendProvider(): DataProvider {
  return governanceStatProvider(
    'agent.usage.trend',
    (queries, range) => queries.usageTrend(range),
    (points) => ({ rows: toUsageTrendRows(points) }),
  );
}

/** table → spend per acting ref (user/tenant). */
export function agentActorSpendTableProvider(): DataProvider {
  return governanceStatProvider(
    'agent.spend.byActor',
    (queries, range) => queries.spendByActor(range),
    (rows) => ({ rows: toActorSpendRows(rows) }),
  );
}

/** breakdown → spend share per actor. */
export function agentSpendByActorProvider(): DataProvider {
  return governanceStatProvider(
    'agent.spend.byActorShare',
    (queries, range) => queries.spendByActor(range),
    (rows) => ({ segments: toActorSpendSegments(rows) }),
  );
}

/** table → top threads by cost (title, actor, requests, tokens, cost). */
export function agentTopThreadsTableProvider(): DataProvider {
  return governanceStatProvider(
    'agent.threads.topSpend',
    (queries, range) => queries.spendByThread(range, TOP_THREADS_LIMIT),
    (rows) => ({ rows: toThreadSpendRows(rows) }),
  );
}

// ─── Reliability providers ────────────────────────────────────────────────────

/**
 * Build a `DataProvider` from ONE range-scoped `runMetrics` call + a format step — the
 * `governanceStatProvider` pattern specialized for the single-object `RunMetrics` shape (the five
 * reliability stats all reuse the same underlying query, exactly like the spend stats above reuse
 * `spendByModel`). Degrades to {@link EMPTY_RUN_METRICS} when the read-model isn't bound.
 */
function governanceRunMetricsProvider(
  name: string,
  format: (metrics: RunMetrics) => unknown,
): DataProvider {
  return {
    name,
    async resolve(query, ctx) {
      const queries = resolveGovernanceQueries(ctx);
      const metrics = queries ? await queries.runMetrics(resolveRange(query)) : EMPTY_RUN_METRICS;
      return format(metrics);
    },
  };
}

/** stat → total runs over the range. */
export function agentRunsTotalProvider(): DataProvider {
  return governanceRunMetricsProvider('agent.runs.total', (metrics) => ({ value: metrics.runs }));
}

/** stat → completed/total success rate over the range. */
export function agentRunsSuccessRateProvider(): DataProvider {
  return governanceRunMetricsProvider('agent.runs.successRate', (metrics) => ({
    value: metrics.successRate,
  }));
}

/** stat → failed run count over the range. */
export function agentRunsFailedProvider(): DataProvider {
  return governanceRunMetricsProvider('agent.runs.failed', (metrics) => ({
    value: metrics.failed,
  }));
}

/** stat → total llm-step retries across the range's runs. */
export function agentRunsRetriesProvider(): DataProvider {
  return governanceRunMetricsProvider('agent.runs.retries', (metrics) => ({
    value: metrics.retries,
  }));
}

/**
 * stat → run duration percentile, selected by `query.metric` (`'p95'` for p95, anything else —
 * including omitted — for p50), mirroring `durable.duration`'s stat shortcut. NOT a
 * `distribution` panel: `RunMetrics` exposes only the two percentiles (no raw per-run samples to
 * bucket into a histogram), so a distribution here would render as a permanently-empty box. A
 * `null` percentile (no settled runs in range) resolves to 0.
 */
export function agentRunsDurationProvider(): DataProvider {
  return {
    name: 'agent.runs.duration',
    async resolve(query, ctx) {
      const queries = resolveGovernanceQueries(ctx);
      const metrics = queries ? await queries.runMetrics(resolveRange(query)) : EMPTY_RUN_METRICS;
      const value = query?.metric === 'p95' ? metrics.durationP95Ms : metrics.durationP50Ms;
      return { value: value ?? 0 };
    },
  };
}

/** table → run/failure/retry rollup per agent. */
export function agentRunsByAgentTableProvider(): DataProvider {
  return governanceStatProvider(
    'agent.runs.byAgent',
    (queries, range) => queries.runsByAgent(range),
    (rows) => ({ rows: toRunAgentTableRows(rows) }),
  );
}

/** breakdown → failed runs by error code. */
export function agentRunErrorsProvider(): DataProvider {
  return governanceStatProvider(
    'agent.runs.errors',
    (queries, range) => queries.runErrors(range),
    (rows) => ({ segments: toRunErrorSegments(rows) }),
  );
}

/** timeseries → daily runs + failures trend. */
export function agentRunsTrendProvider(): DataProvider {
  return governanceStatProvider(
    'agent.runs.trend',
    (queries, range) => queries.runTrend(range),
    (points) => ({ rows: toRunTrendRows(points) }),
  );
}

// ─── Limit-scoped providers (recent-activity feeds + the approvals inbox) ────

/** Default row count for a "recent …" feed when a panel's query omits `limit`. */
const DEFAULT_RECENT_LIMIT = 50;
/** Hard ceiling on `limit`, regardless of what a panel's query requests. */
const MAX_RECENT_LIMIT = 500;

/** Clamp a panel-supplied `limit` into `[1, MAX_RECENT_LIMIT]`, defaulting when absent/invalid. */
function resolveLimit(query: Record<string, unknown> | undefined, fallback: number): number {
  const raw = query?.limit;
  const value = typeof raw === 'number' && Number.isFinite(raw) ? raw : fallback;
  return Math.min(MAX_RECENT_LIMIT, Math.max(1, Math.trunc(value)));
}

/**
 * Build a governance `DataProvider` from a `limit`-scoped fetch + a format step — the sibling of
 * {@link governanceStatProvider} for the read-model's "recent N" queries, which take a row cap
 * instead of a day range. Degrades to `[]` when the read-model isn't bound.
 */
function governanceLimitProvider<TRow>(
  name: string,
  defaultLimit: number,
  fetch: (queries: AgentGovernanceQueries, limit: number) => Promise<TRow[]>,
  format: (rows: TRow[]) => unknown,
): DataProvider {
  return {
    name,
    async resolve(query, ctx) {
      const queries = resolveGovernanceQueries(ctx);
      const rows = queries ? await fetch(queries, resolveLimit(query, defaultLimit)) : [];
      return format(rows);
    },
  };
}

/**
 * table → most recent runs (newest first), errorMessage capped and promptHash shortened to a chip
 * — see {@link capErrorMessage} for why the cap happens here rather than downstream.
 */
export function agentRecentRunsTableProvider(): DataProvider {
  return governanceLimitProvider(
    'agent.runs.recent',
    DEFAULT_RECENT_LIMIT,
    (queries, limit) => queries.recentRuns(limit),
    (rows) => ({ rows: toRecentRunTableRows(rows) }),
  );
}

/**
 * table → most recent tool calls (newest first), from the durable read-model. Replaces the
 * ephemeral, watcher-fed `agent.tools` provider in `agent-data-providers.ts` for the shipped
 * dashboard — see that file's header comment for why.
 */
export function agentRecentToolCallsTableProvider(): DataProvider {
  return governanceLimitProvider(
    'agent.tools.recent',
    DEFAULT_RECENT_LIMIT,
    (queries, limit) => queries.recentToolCalls(limit),
    (rows) => ({ rows: toRecentToolCallRows(rows) }),
  );
}

/** table → most recently active threads, with rolled-up message/token counts. */
export function agentRecentThreadsTableProvider(): DataProvider {
  return governanceLimitProvider(
    'agent.threads.recent',
    DEFAULT_RECENT_LIMIT,
    (queries, limit) => queries.recentThreads(limit),
    (rows) => ({ rows: toRecentThreadTableRows(rows) }),
  );
}

/** Row cap used to approximate a "pending approvals" COUNT (the SPI only exposes a capped list —
 * see {@link agentPendingApprovalsCountProvider}). */
const PENDING_APPROVALS_COUNT_LIMIT = 500;

/**
 * stat → count of tool calls sitting `pending_approval` across every thread. The SPI's
 * `pendingApprovals` only returns a capped list, not a true count, so this undercounts a backlog
 * larger than {@link PENDING_APPROVALS_COUNT_LIMIT} — a backlog that size signals a bigger
 * operational problem than an off-by-N stat, so the approximation is an acceptable tradeoff.
 */
export function agentPendingApprovalsCountProvider(): DataProvider {
  return {
    name: 'agent.approvals.pending',
    async resolve(_query, ctx) {
      const queries = resolveGovernanceQueries(ctx);
      const rows = queries ? await queries.pendingApprovals(PENDING_APPROVALS_COUNT_LIMIT) : [];
      return { value: rows.length };
    },
  };
}

/** table → the pending-approvals inbox, oldest request first. */
export function agentPendingApprovalsTableProvider(): DataProvider {
  return governanceLimitProvider(
    'agent.approvals.recent',
    DEFAULT_RECENT_LIMIT,
    (queries, limit) => queries.pendingApprovals(limit),
    (rows) => ({ rows: toPendingApprovalTableRows(rows) }),
  );
}

/** table → per-tool call/failure/rejection/latency rollup over the range. */
export function agentToolStatsTableProvider(): DataProvider {
  return governanceStatProvider(
    'agent.tools.stats',
    (queries, range) => queries.toolStats(range),
    (rows) => ({ rows: toToolStatTableRows(rows) }),
  );
}
