import type {
  ActorSpendRow,
  AgentGovernanceQueries,
  GovernanceRange,
  ModelSpendRow,
  ThreadActivityRow,
  ToolCallActivityRow,
  UsageTrendPoint,
} from '@dudousxd/nestjs-agent-core';
import type { EntityManager } from '@mikro-orm/core';
import { AgentMessage } from './entities/agent-message.entity';
import { AgentModelPricing } from './entities/agent-model-pricing.entity';
import { AgentThread } from './entities/agent-thread.entity';
import { AgentTokenUsage } from './entities/agent-token-usage.entity';
import { AgentToolCall } from './entities/agent-tool-call.entity';

/** The current per-1M token prices for one model. */
interface ModelPrice {
  inputPricePer1m: number;
  outputPricePer1m: number;
}

/**
 * `costUsd = inputTokens/1e6 * inputPricePer1m + outputTokens/1e6 * outputPricePer1m` against the
 * current pricing row for the model. An unpriced model contributes 0 (its tokens still count).
 */
function costForModel(
  pricing: Map<string, ModelPrice>,
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
 * The cost of one usage row: the provider-reported `costUsd` when present (gateways report real
 * spend), otherwise the token-ledger estimate against the current pricing row.
 */
function rowCost(pricing: Map<string, ModelPrice>, row: AgentTokenUsage): number {
  return row.costUsd ?? costForModel(pricing, row.modelId, row.inputTokens, row.outputTokens);
}

/** Turns an inclusive `YYYY-MM-DD` day range into the UTC datetime bounds used by `quotaToday`. */
function dayBounds(range: GovernanceRange): { start: Date; end: Date } {
  return {
    start: new Date(`${range.fromDay}T00:00:00.000Z`),
    end: new Date(`${range.toDay}T23:59:59.999Z`),
  };
}

/**
 * {@link AgentGovernanceQueries} backed by MikroORM — the read/analytics half of the store SPI
 * (the write/thread half is {@link import('./mikro-orm-agent-store').MikroOrmAgentStore}). Cost is
 * the token ledger joined to the current pricing row per model (`AgentModelPricing.isCurrent`); an
 * unpriced model contributes 0 cost. Each operation runs on a fresh `em.fork()`, mirroring the
 * store, and aggregates in-process (like `quotaToday`) so the day-bucketing stays engine-portable.
 */
export class MikroOrmGovernanceQueries implements AgentGovernanceQueries {
  constructor(private readonly em: EntityManager) {}

  private async loadPricing(em: EntityManager): Promise<Map<string, ModelPrice>> {
    const rows = await em.find(AgentModelPricing, { isCurrent: true });
    const pricing = new Map<string, ModelPrice>();
    for (const row of rows) {
      pricing.set(row.modelId, {
        inputPricePer1m: row.inputPricePer1m,
        outputPricePer1m: row.outputPricePer1m,
      });
    }
    return pricing;
  }

  private async usageInRange(
    em: EntityManager,
    range: GovernanceRange,
  ): Promise<AgentTokenUsage[]> {
    const { start, end } = dayBounds(range);
    return em.find(AgentTokenUsage, { createdAt: { $gte: start, $lte: end } });
  }

  async spendByModel(range: GovernanceRange): Promise<ModelSpendRow[]> {
    const em = this.em.fork();
    const pricing = await this.loadPricing(em);
    const rows = await this.usageInRange(em, range);
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
      bucket.costUsd += rowCost(pricing, row);
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
    const em = this.em.fork();
    const pricing = await this.loadPricing(em);
    const rows = await this.usageInRange(em, range);
    const byActor = new Map<string, { requests: number; totalTokens: number; costUsd: number }>();
    for (const row of rows) {
      const bucket = byActor.get(row.actorRef) ?? { requests: 0, totalTokens: 0, costUsd: 0 };
      bucket.requests += 1;
      bucket.totalTokens += row.inputTokens + row.outputTokens;
      bucket.costUsd += rowCost(pricing, row);
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
    const em = this.em.fork();
    const pricing = await this.loadPricing(em);
    const rows = await this.usageInRange(em, range);
    const byDay = new Map<string, { totalTokens: number; costUsd: number }>();
    for (const row of rows) {
      const day = row.createdAt.toISOString().slice(0, 10);
      const bucket = byDay.get(day) ?? { totalTokens: 0, costUsd: 0 };
      bucket.totalTokens += row.inputTokens + row.outputTokens;
      bucket.costUsd += rowCost(pricing, row);
      byDay.set(day, bucket);
    }
    const result: UsageTrendPoint[] = [];
    for (const [day, bucket] of byDay) {
      result.push({ day, totalTokens: bucket.totalTokens, costUsd: bucket.costUsd });
    }
    result.sort((left, right) => left.day.localeCompare(right.day));
    return result;
  }

  async recentToolCalls(limit: number): Promise<ToolCallActivityRow[]> {
    const em = this.em.fork();
    const rows = await em.find(
      AgentToolCall,
      {},
      { orderBy: { createdAt: 'desc', id: 'desc' }, limit, populate: ['message'] },
    );
    return rows.map((toolCall) => ({
      toolCallId: toolCall.id,
      toolName: toolCall.toolName,
      toolType: toolCall.toolType,
      status: toolCall.status,
      threadId: toolCall.message.thread.id,
      createdAt: toolCall.createdAt.toISOString(),
    }));
  }

  async recentThreads(limit: number): Promise<ThreadActivityRow[]> {
    const em = this.em.fork();
    const threads = await em.find(
      AgentThread,
      { deletedAt: null },
      { orderBy: { updatedAt: 'desc', id: 'desc' }, limit },
    );
    const result: ThreadActivityRow[] = [];
    for (const thread of threads) {
      const messageCount = await em.count(AgentMessage, { thread });
      const usageRows = await em.find(AgentTokenUsage, { thread });
      const totalTokens = usageRows.reduce(
        (sum, row) => sum + row.inputTokens + row.outputTokens,
        0,
      );
      result.push({
        threadId: thread.id,
        title: thread.title,
        actorRef: thread.actorRef,
        messageCount,
        totalTokens,
        lastActivityAt: thread.updatedAt.toISOString(),
      });
    }
    return result;
  }
}
