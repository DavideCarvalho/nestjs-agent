import type {
  ActorSpendRow,
  AgentGovernanceQueries,
  GovernanceRange,
  ModelSpendRow,
  ThreadSpendRow,
  UsageTrendPoint,
} from '@dudousxd/nestjs-agent-core';
import { AGENT_GOVERNANCE_QUERIES } from '@dudousxd/nestjs-agent-core';
import type { DataProvider, ExtensionContext } from '@dudousxd/nestjs-telescope';

/**
 * Governance data providers for the "Agent" Telescope tab. Unlike the live watcher-fed providers
 * in `agent-data-providers.ts` (which read the ephemeral Telescope event storage), these read the
 * authoritative, restart-surviving read-model: `AGENT_GOVERNANCE_QUERIES` (usage ⋈ pricing).
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
    typeof value.recentThreads === 'function'
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
