import type {
  ActorSpendRow,
  AgentGovernanceQueries,
  GovernanceRange,
  ModelSpendRow,
  ThreadActivityRow,
  ToolCallActivityRow,
  UsageTrendPoint,
} from '@dudousxd/nestjs-agent-core';
import type { GovernanceUsageRow, InMemoryAgentStore } from './in-memory-store.js';

/** The current per-1M token prices for one model. */
export interface InMemoryModelPrice {
  inputPricePer1m: number;
  outputPricePer1m: number;
}

/**
 * `costUsd = inputTokens/1e6 * inputPricePer1m + outputTokens/1e6 * outputPricePer1m` from the
 * supplied pricing map. An unpriced model (missing from the map) contributes 0 — so the default
 * empty map yields 0 cost everywhere while still counting tokens.
 */
function costForModel(
  pricing: ReadonlyMap<string, InMemoryModelPrice>,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const price = pricing.get(modelId);
  if (price === undefined) {
    return 0;
  }
  return (
    (inputTokens / 1_000_000) * price.inputPricePer1m +
    (outputTokens / 1_000_000) * price.outputPricePer1m
  );
}

/**
 * A fully in-memory {@link AgentGovernanceQueries} for unit tests and the offline demo. Aggregates
 * the usage/tool-call/thread rows recorded on an {@link InMemoryAgentStore}. Pricing is an optional
 * map keyed by `modelId`; omit it (default empty) for a zero-cost read-model that still reports
 * token usage. Mirrors the SQL adapters' cost formula and inclusive-day semantics.
 */
export class InMemoryGovernanceQueries implements AgentGovernanceQueries {
  constructor(
    private readonly store: InMemoryAgentStore,
    private readonly pricing: ReadonlyMap<string, InMemoryModelPrice> = new Map(),
  ) {}

  private inRange(day: string, range: GovernanceRange): boolean {
    return day >= range.fromDay && day <= range.toDay;
  }

  /** Provider-reported cost wins per row; otherwise estimate from tokens × pricing. */
  private rowCost(row: GovernanceUsageRow): number {
    return (
      row.costUsd ?? costForModel(this.pricing, row.modelId, row.inputTokens, row.outputTokens)
    );
  }

  async spendByModel(range: GovernanceRange): Promise<ModelSpendRow[]> {
    const byModel = new Map<
      string,
      { requests: number; inputTokens: number; outputTokens: number; costUsd: number }
    >();
    for (const row of this.store.governanceUsage()) {
      if (!this.inRange(row.day, range)) {
        continue;
      }
      const bucket = byModel.get(row.modelId) ?? {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
        costUsd: 0,
      };
      bucket.requests += 1;
      bucket.inputTokens += row.inputTokens;
      bucket.outputTokens += row.outputTokens;
      bucket.costUsd += this.rowCost(row);
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

  async spendByActor(range: GovernanceRange): Promise<ActorSpendRow[]> {
    const byActor = new Map<string, { requests: number; totalTokens: number; costUsd: number }>();
    for (const row of this.store.governanceUsage()) {
      if (!this.inRange(row.day, range)) {
        continue;
      }
      const bucket = byActor.get(row.actorRef) ?? { requests: 0, totalTokens: 0, costUsd: 0 };
      bucket.requests += 1;
      bucket.totalTokens += row.inputTokens + row.outputTokens;
      bucket.costUsd += this.rowCost(row);
      byActor.set(row.actorRef, bucket);
    }
    const result: ActorSpendRow[] = [];
    for (const [actorRef, bucket] of byActor) {
      result.push({
        actorRef,
        requests: bucket.requests,
        totalTokens: bucket.totalTokens,
        costUsd: bucket.costUsd,
      });
    }
    result.sort(
      (left, right) => right.costUsd - left.costUsd || left.actorRef.localeCompare(right.actorRef),
    );
    return result;
  }

  async usageTrend(range: GovernanceRange): Promise<UsageTrendPoint[]> {
    const byDay = new Map<string, { totalTokens: number; costUsd: number }>();
    for (const row of this.store.governanceUsage()) {
      if (!this.inRange(row.day, range)) {
        continue;
      }
      const bucket = byDay.get(row.day) ?? { totalTokens: 0, costUsd: 0 };
      bucket.totalTokens += row.inputTokens + row.outputTokens;
      bucket.costUsd += this.rowCost(row);
      byDay.set(row.day, bucket);
    }
    const result: UsageTrendPoint[] = [];
    for (const [day, bucket] of byDay) {
      result.push({ day, totalTokens: bucket.totalTokens, costUsd: bucket.costUsd });
    }
    result.sort((left, right) => left.day.localeCompare(right.day));
    return result;
  }

  async recentToolCalls(limit: number): Promise<ToolCallActivityRow[]> {
    return [...this.store.governanceToolCalls()]
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt))
      .slice(0, limit)
      .map((row) => ({
        toolCallId: row.toolCallId,
        toolName: row.toolName,
        toolType: row.toolType,
        status: row.status,
        threadId: row.threadId,
        createdAt: row.createdAt,
      }));
  }

  async recentThreads(limit: number): Promise<ThreadActivityRow[]> {
    const usage = this.store.governanceUsage();
    return [...this.store.governanceThreads()]
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
      .slice(0, limit)
      .map((thread) => {
        const totalTokens = usage
          .filter((row) => row.threadId === thread.threadId)
          .reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
        return {
          threadId: thread.threadId,
          title: thread.title,
          actorRef: thread.actorRef,
          messageCount: thread.messageCount,
          totalTokens,
          lastActivityAt: thread.updatedAt,
        };
      });
  }
}
