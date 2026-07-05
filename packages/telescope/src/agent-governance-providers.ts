import type {
  ActorSpendRow,
  AgentGovernanceQueries,
  GovernanceRange,
  ModelSpendRow,
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

/** stat → authoritative total spend (USD) over the range. */
export function agentSpendTotalProvider(): DataProvider {
  return {
    name: 'agent.spend.totalCost',
    async resolve(query, ctx) {
      const queries = resolveGovernanceQueries(ctx);
      if (!queries) {
        return { value: 0 };
      }
      const byModel = await queries.spendByModel(resolveRange(query));
      return { value: totalCostUsd(byModel) };
    },
  };
}

/** stat → authoritative total tokens (input + output) over the range. */
export function agentTokensTotalProvider(): DataProvider {
  return {
    name: 'agent.spend.totalTokens',
    async resolve(query, ctx) {
      const queries = resolveGovernanceQueries(ctx);
      if (!queries) {
        return { value: 0 };
      }
      const byModel = await queries.spendByModel(resolveRange(query));
      return { value: totalTokens(byModel) };
    },
  };
}

/** breakdown → spend share per model. */
export function agentSpendByModelProvider(): DataProvider {
  return {
    name: 'agent.spend.byModel',
    async resolve(query, ctx) {
      const queries = resolveGovernanceQueries(ctx);
      if (!queries) {
        return { segments: [] };
      }
      const byModel = await queries.spendByModel(resolveRange(query));
      return { segments: toModelSpendSegments(byModel) };
    },
  };
}

/** table → per-model requests / in+out tokens / cost. */
export function agentModelSpendTableProvider(): DataProvider {
  return {
    name: 'agent.spend.byModelTable',
    async resolve(query, ctx) {
      const queries = resolveGovernanceQueries(ctx);
      if (!queries) {
        return { rows: [] };
      }
      const byModel = await queries.spendByModel(resolveRange(query));
      return { rows: toModelSpendRows(byModel) };
    },
  };
}

/** timeseries → daily spend + tokens trend. */
export function agentUsageTrendProvider(): DataProvider {
  return {
    name: 'agent.usage.trend',
    async resolve(query, ctx) {
      const queries = resolveGovernanceQueries(ctx);
      if (!queries) {
        return { rows: [] };
      }
      const trend = await queries.usageTrend(resolveRange(query));
      return { rows: toUsageTrendRows(trend) };
    },
  };
}

/** table → spend per acting ref (user/tenant). */
export function agentActorSpendTableProvider(): DataProvider {
  return {
    name: 'agent.spend.byActor',
    async resolve(query, ctx) {
      const queries = resolveGovernanceQueries(ctx);
      if (!queries) {
        return { rows: [] };
      }
      const byActor = await queries.spendByActor(resolveRange(query));
      return { rows: toActorSpendRows(byActor) };
    },
  };
}

/** breakdown → spend share per actor. */
export function agentSpendByActorProvider(): DataProvider {
  return {
    name: 'agent.spend.byActorShare',
    async resolve(query, ctx) {
      const queries = resolveGovernanceQueries(ctx);
      if (!queries) {
        return { segments: [] };
      }
      const byActor = await queries.spendByActor(resolveRange(query));
      return { segments: toActorSpendSegments(byActor) };
    },
  };
}
