import type {
  ActorSpendRow,
  GovernanceRange,
  ModelSpendRow,
  ThreadSpendRow,
  UsageTrendPoint,
} from '../spi/governance-queries.js';

/**
 * The pure aggregation core shared by every {@link import('../spi/governance-queries.js').AgentGovernanceQueries}
 * adapter (MikroORM, Drizzle, in-memory). An adapter's only job is the DB-specific row fetch; the
 * cost formula, the group→sort bucketing, and the day-bounds math live here so all three surfaces
 * report identical numbers.
 */

/** The current per-1M token prices for one model; cache rates fall back to the input rate. */
export interface ModelPrice {
  inputPricePer1m: number;
  outputPricePer1m: number;
  cacheWritePricePer1m?: number | null;
  cacheReadPricePer1m?: number | null;
}

/** The token split of one turn needed to estimate its cost. */
export interface CostUsage {
  inputTokens: number;
  outputTokens: number;
  cacheWriteTokens?: number | null | undefined;
  cacheReadTokens?: number | null | undefined;
}

/**
 * A normalized usage row the bucketers consume. Each adapter maps its raw DB row into this shape
 * (MikroORM reads `thread.id` + `createdAt`, Drizzle/in-memory read the flat `threadId` + `day`).
 */
export interface GovernanceUsageInput extends CostUsage {
  modelId: string;
  actorRef: string;
  threadId: string;
  /** The `YYYY-MM-DD` UTC day the row belongs to (its trend bucket). */
  day: string;
  /** Provider-reported spend for the row; wins over the token estimate when present. */
  costUsd?: number | null | undefined;
}

/** Thread metadata joined onto a spend bucket. */
export interface ThreadMeta {
  title: string;
  actorRef: string;
}

/**
 * Token-ledger estimate for one turn against a pricing row: the uncached input at the input rate,
 * cache-write/cache-read tokens at their own rates (falling back to the input rate when unpriced),
 * plus output at the output rate. An unpriced model (`price === undefined`) contributes 0 — its
 * tokens still count. Cache token counts are subsets of `inputTokens`, so the uncached remainder is
 * the difference.
 */
export function estimateCost(usage: CostUsage, price: ModelPrice | undefined): number {
  if (price === undefined) {
    return 0;
  }
  const cacheWriteTokens = usage.cacheWriteTokens ?? 0;
  const cacheReadTokens = usage.cacheReadTokens ?? 0;
  const uncachedInputTokens = usage.inputTokens - cacheWriteTokens - cacheReadTokens;
  return (
    (uncachedInputTokens / 1_000_000) * price.inputPricePer1m +
    (cacheWriteTokens / 1_000_000) * (price.cacheWritePricePer1m ?? price.inputPricePer1m) +
    (cacheReadTokens / 1_000_000) * (price.cacheReadPricePer1m ?? price.inputPricePer1m) +
    (usage.outputTokens / 1_000_000) * price.outputPricePer1m
  );
}

/** Provider-reported cost wins per row; otherwise the cache-aware token estimate. */
function rowCost(row: GovernanceUsageInput, prices: ReadonlyMap<string, ModelPrice>): number {
  return row.costUsd ?? estimateCost(row, prices.get(row.modelId));
}

/** Aggregate usage rows into per-model spend, highest cost first then modelId ascending. */
export function bucketByModel(
  rows: GovernanceUsageInput[],
  prices: ReadonlyMap<string, ModelPrice>,
): ModelSpendRow[] {
  const byModel = new Map<
    string,
    { requests: number; inputTokens: number; outputTokens: number; costUsd: number }
  >();
  for (const row of rows) {
    const bucket = byModel.get(row.modelId) ?? {
      requests: 0,
      inputTokens: 0,
      outputTokens: 0,
      costUsd: 0,
    };
    bucket.requests += 1;
    bucket.inputTokens += row.inputTokens;
    bucket.outputTokens += row.outputTokens;
    bucket.costUsd += rowCost(row, prices);
    byModel.set(row.modelId, bucket);
  }
  const result: ModelSpendRow[] = [];
  for (const [modelId, bucket] of byModel) {
    result.push({
      modelId,
      requests: bucket.requests,
      inputTokens: bucket.inputTokens,
      outputTokens: bucket.outputTokens,
      costUsd: bucket.costUsd,
    });
  }
  result.sort(
    (left, right) => right.costUsd - left.costUsd || left.modelId.localeCompare(right.modelId),
  );
  return result;
}

/** Aggregate usage rows into per-actor spend (with distinct thread counts), highest cost first. */
export function bucketByActor(
  rows: GovernanceUsageInput[],
  prices: ReadonlyMap<string, ModelPrice>,
): ActorSpendRow[] {
  const byActor = new Map<
    string,
    { requests: number; totalTokens: number; costUsd: number; threadIds: Set<string> }
  >();
  for (const row of rows) {
    const bucket = byActor.get(row.actorRef) ?? {
      requests: 0,
      totalTokens: 0,
      costUsd: 0,
      threadIds: new Set<string>(),
    };
    bucket.requests += 1;
    bucket.totalTokens += row.inputTokens + row.outputTokens;
    bucket.costUsd += rowCost(row, prices);
    bucket.threadIds.add(row.threadId);
    byActor.set(row.actorRef, bucket);
  }
  const result: ActorSpendRow[] = [];
  for (const [actorRef, bucket] of byActor) {
    result.push({
      actorRef,
      requests: bucket.requests,
      totalTokens: bucket.totalTokens,
      costUsd: bucket.costUsd,
      threadCount: bucket.threadIds.size,
    });
  }
  result.sort(
    (left, right) => right.costUsd - left.costUsd || left.actorRef.localeCompare(right.actorRef),
  );
  return result;
}

/**
 * Aggregate usage rows into per-thread spend, highest cost first then threadId ascending, capped at
 * `limit`. A thread absent from `threads` is dropped when `includeUnknownThreads` is false (the SQL
 * adapters fetch only non-deleted threads, so a soft-deleted thread's rows vanish from the ranking);
 * when true it is kept with blank title/actor (the in-memory adapter's semantics).
 */
export function bucketByThread(
  rows: GovernanceUsageInput[],
  prices: ReadonlyMap<string, ModelPrice>,
  threads: ReadonlyMap<string, ThreadMeta>,
  options: { limit: number; includeUnknownThreads: boolean },
): ThreadSpendRow[] {
  const byThread = new Map<string, { requests: number; totalTokens: number; costUsd: number }>();
  for (const row of rows) {
    const bucket = byThread.get(row.threadId) ?? { requests: 0, totalTokens: 0, costUsd: 0 };
    bucket.requests += 1;
    bucket.totalTokens += row.inputTokens + row.outputTokens;
    bucket.costUsd += rowCost(row, prices);
    byThread.set(row.threadId, bucket);
  }
  const result: ThreadSpendRow[] = [];
  for (const [threadId, bucket] of byThread) {
    const thread = threads.get(threadId);
    if (thread === undefined && !options.includeUnknownThreads) {
      continue;
    }
    result.push({
      threadId,
      title: thread?.title ?? '',
      actorRef: thread?.actorRef ?? '',
      requests: bucket.requests,
      totalTokens: bucket.totalTokens,
      costUsd: bucket.costUsd,
    });
  }
  result.sort(
    (left, right) => right.costUsd - left.costUsd || left.threadId.localeCompare(right.threadId),
  );
  return result.slice(0, options.limit);
}

/** Aggregate usage rows into a daily token/cost trend, ascending by day. */
export function bucketUsageTrend(
  rows: GovernanceUsageInput[],
  prices: ReadonlyMap<string, ModelPrice>,
): UsageTrendPoint[] {
  const byDay = new Map<string, { totalTokens: number; costUsd: number }>();
  for (const row of rows) {
    const bucket = byDay.get(row.day) ?? { totalTokens: 0, costUsd: 0 };
    bucket.totalTokens += row.inputTokens + row.outputTokens;
    bucket.costUsd += rowCost(row, prices);
    byDay.set(row.day, bucket);
  }
  const result: UsageTrendPoint[] = [];
  for (const [day, bucket] of byDay) {
    result.push({ day, totalTokens: bucket.totalTokens, costUsd: bucket.costUsd });
  }
  result.sort((left, right) => left.day.localeCompare(right.day));
  return result;
}

/** Turn an inclusive `YYYY-MM-DD` day range into the UTC datetime bounds used to filter usage rows. */
export function dayBoundsUtc(range: GovernanceRange): { start: Date; end: Date } {
  return {
    start: new Date(`${range.fromDay}T00:00:00.000Z`),
    end: new Date(`${range.toDay}T23:59:59.999Z`),
  };
}
