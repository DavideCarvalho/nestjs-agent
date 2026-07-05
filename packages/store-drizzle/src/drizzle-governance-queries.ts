import type {
  ActorSpendRow,
  AgentGovernanceQueries,
  GovernanceRange,
  ModelSpendRow,
  ThreadActivityRow,
  ToolCallActivityRow,
  UsageTrendPoint,
} from '@dudousxd/nestjs-agent-core';
import { and, count, desc, eq, gte, isNull, lte } from 'drizzle-orm';
import {
  type AgentDrizzleDb,
  agentMessage,
  agentModelPricing,
  agentThread,
  agentTokenUsage,
  agentToolCall,
} from './schema.js';

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

/** Turns an inclusive `YYYY-MM-DD` day range into the UTC datetime bounds used by `quotaToday`. */
function dayBounds(range: GovernanceRange): { start: Date; end: Date } {
  return {
    start: new Date(`${range.fromDay}T00:00:00.000Z`),
    end: new Date(`${range.toDay}T23:59:59.999Z`),
  };
}

/**
 * {@link AgentGovernanceQueries} backed by Drizzle ORM — the read/analytics half of the store SPI,
 * mirroring {@link import('@dudousxd/nestjs-agent-store-mikro-orm')} exactly. Cost is the token
 * ledger joined to the current pricing row per model (`agentModelPricing.isCurrent`); an unpriced
 * model contributes 0 cost. Aggregation is in-process (like `quotaToday`) so day-bucketing stays
 * dialect-portable.
 */
export class DrizzleGovernanceQueries implements AgentGovernanceQueries {
  constructor(private readonly db: AgentDrizzleDb) {}

  private async loadPricing(): Promise<Map<string, ModelPrice>> {
    const rows = await this.db
      .select()
      .from(agentModelPricing)
      .where(eq(agentModelPricing.isCurrent, true));
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
    range: GovernanceRange,
  ): Promise<(typeof agentTokenUsage.$inferSelect)[]> {
    const { start, end } = dayBounds(range);
    const rows = await this.db
      .select()
      .from(agentTokenUsage)
      .where(and(gte(agentTokenUsage.createdAt, start), lte(agentTokenUsage.createdAt, end)));
    return rows;
  }

  async spendByModel(range: GovernanceRange): Promise<ModelSpendRow[]> {
    const pricing = await this.loadPricing();
    const rows = await this.usageInRange(range);
    const byModel = new Map<
      string,
      { requests: number; inputTokens: number; outputTokens: number }
    >();
    for (const row of rows) {
      const bucket = byModel.get(row.modelId) ?? {
        requests: 0,
        inputTokens: 0,
        outputTokens: 0,
      };
      bucket.requests += 1;
      bucket.inputTokens += row.inputTokens;
      bucket.outputTokens += row.outputTokens;
      byModel.set(row.modelId, bucket);
    }
    const result: ModelSpendRow[] = [];
    for (const [modelId, bucket] of byModel) {
      result.push({
        modelId,
        requests: bucket.requests,
        inputTokens: bucket.inputTokens,
        outputTokens: bucket.outputTokens,
        costUsd: costForModel(pricing, modelId, bucket.inputTokens, bucket.outputTokens),
      });
    }
    result.sort(
      (left, right) => right.costUsd - left.costUsd || left.modelId.localeCompare(right.modelId),
    );
    return result;
  }

  async spendByActor(range: GovernanceRange): Promise<ActorSpendRow[]> {
    const pricing = await this.loadPricing();
    const rows = await this.usageInRange(range);
    const byActor = new Map<string, { requests: number; totalTokens: number; costUsd: number }>();
    for (const row of rows) {
      const bucket = byActor.get(row.actorRef) ?? { requests: 0, totalTokens: 0, costUsd: 0 };
      bucket.requests += 1;
      bucket.totalTokens += row.inputTokens + row.outputTokens;
      bucket.costUsd += costForModel(pricing, row.modelId, row.inputTokens, row.outputTokens);
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
    const pricing = await this.loadPricing();
    const rows = await this.usageInRange(range);
    const byDay = new Map<string, { totalTokens: number; costUsd: number }>();
    for (const row of rows) {
      const day = row.createdAt.toISOString().slice(0, 10);
      const bucket = byDay.get(day) ?? { totalTokens: 0, costUsd: 0 };
      bucket.totalTokens += row.inputTokens + row.outputTokens;
      bucket.costUsd += costForModel(pricing, row.modelId, row.inputTokens, row.outputTokens);
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
    const rows = await this.db
      .select({
        toolCallId: agentToolCall.id,
        toolName: agentToolCall.toolName,
        toolType: agentToolCall.toolType,
        status: agentToolCall.status,
        threadId: agentMessage.threadId,
        createdAt: agentToolCall.createdAt,
      })
      .from(agentToolCall)
      .innerJoin(agentMessage, eq(agentToolCall.messageId, agentMessage.id))
      .orderBy(desc(agentToolCall.createdAt), desc(agentToolCall.id))
      .limit(limit);
    return rows.map((row) => ({
      toolCallId: row.toolCallId,
      toolName: row.toolName,
      toolType: row.toolType,
      status: row.status,
      threadId: row.threadId,
      createdAt: row.createdAt.toISOString(),
    }));
  }

  async recentThreads(limit: number): Promise<ThreadActivityRow[]> {
    const threads = await this.db
      .select()
      .from(agentThread)
      .where(isNull(agentThread.deletedAt))
      .orderBy(desc(agentThread.updatedAt), desc(agentThread.id))
      .limit(limit);
    const result: ThreadActivityRow[] = [];
    for (const thread of threads) {
      const [messageCountRow] = await this.db
        .select({ value: count() })
        .from(agentMessage)
        .where(eq(agentMessage.threadId, thread.id));
      const usageRows = await this.db
        .select()
        .from(agentTokenUsage)
        .where(eq(agentTokenUsage.threadId, thread.id));
      const totalTokens = usageRows.reduce(
        (sum, row) => sum + row.inputTokens + row.outputTokens,
        0,
      );
      result.push({
        threadId: thread.id,
        title: thread.title,
        actorRef: thread.actorRef,
        messageCount: messageCountRow?.value ?? 0,
        totalTokens,
        lastActivityAt: thread.updatedAt.toISOString(),
      });
    }
    return result;
  }
}
