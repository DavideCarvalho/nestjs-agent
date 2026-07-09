import type {
  ActorSpendRow,
  AgentGovernanceQueries,
  AgentPricingStore,
  GovernanceRange,
  GovernanceUsageInput,
  ModelPrice,
  ModelSpendRow,
  ThreadActivityRow,
  ThreadMeta,
  ThreadSpendRow,
  ToolCallActivityRow,
  UsageTrendPoint,
} from '@dudousxd/nestjs-agent-core';
import {
  bucketByActor,
  bucketByModel,
  bucketByThread,
  bucketUsageTrend,
  dayBoundsUtc,
} from '@dudousxd/nestjs-agent-core';
import { and, count, desc, eq, gte, inArray, isNull, lte } from 'drizzle-orm';
import {
  type AgentDrizzleDb,
  agentMessage,
  agentThread,
  agentTokenUsage,
  agentToolCall,
} from './schema.js';

/** Map a Drizzle usage row onto the shared bucketer input (day derived from `createdAt`). */
function toUsageInput(row: typeof agentTokenUsage.$inferSelect): GovernanceUsageInput {
  return {
    modelId: row.modelId,
    actorRef: row.actorRef,
    threadId: row.threadId,
    day: row.createdAt.toISOString().slice(0, 10),
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    cacheReadTokens: row.cacheReadTokens,
    costUsd: row.costUsd,
  };
}

/**
 * {@link AgentGovernanceQueries} backed by Drizzle ORM — the read/analytics half of the store SPI,
 * mirroring {@link import('@dudousxd/nestjs-agent-store-mikro-orm')} exactly. Cost is the token
 * ledger priced against the current prices from the injected {@link AgentPricingStore}
 * (`AGENT_PRICING_STORE`), so a host that binds its own pricing store controls the cost every
 * governance surface reports. An unpriced model contributes 0 cost. Aggregation is in-process (like
 * `quotaToday`) so day-bucketing stays dialect-portable.
 */
export class DrizzleGovernanceQueries implements AgentGovernanceQueries {
  constructor(
    private readonly db: AgentDrizzleDb,
    private readonly pricingStore: AgentPricingStore,
  ) {}

  private async loadPricing(): Promise<Map<string, ModelPrice>> {
    const prices = await this.pricingStore.listCurrentPrices();
    const pricing = new Map<string, ModelPrice>();
    for (const price of prices) {
      pricing.set(price.modelId, {
        inputPricePer1m: price.inputPricePer1m,
        outputPricePer1m: price.outputPricePer1m,
        cacheWritePricePer1m: price.cacheWritePricePer1m ?? null,
        cacheReadPricePer1m: price.cacheReadPricePer1m ?? null,
      });
    }
    return pricing;
  }

  private async usageInRange(range: GovernanceRange): Promise<GovernanceUsageInput[]> {
    const { start, end } = dayBoundsUtc(range);
    const rows = await this.db
      .select()
      .from(agentTokenUsage)
      .where(and(gte(agentTokenUsage.createdAt, start), lte(agentTokenUsage.createdAt, end)));
    return rows.map(toUsageInput);
  }

  async spendByModel(range: GovernanceRange): Promise<ModelSpendRow[]> {
    const pricing = await this.loadPricing();
    return bucketByModel(await this.usageInRange(range), pricing);
  }

  async spendByActor(range: GovernanceRange): Promise<ActorSpendRow[]> {
    const pricing = await this.loadPricing();
    return bucketByActor(await this.usageInRange(range), pricing);
  }

  /**
   * Top threads by spend within the range, highest cost first, capped at `limit`. Usage rows for a
   * soft-deleted thread (`deletedAt` set) are excluded — the thread no longer surfaces as a
   * governance target even though its ledger rows survive.
   */
  async spendByThread(range: GovernanceRange, limit: number): Promise<ThreadSpendRow[]> {
    const pricing = await this.loadPricing();
    const rows = await this.usageInRange(range);
    const threadIds = [...new Set(rows.map((row) => row.threadId))];
    if (threadIds.length === 0) {
      return [];
    }
    const threads = await this.db
      .select()
      .from(agentThread)
      .where(and(inArray(agentThread.id, threadIds), isNull(agentThread.deletedAt)));
    const threadsById = new Map<string, ThreadMeta>(
      threads.map((thread) => [thread.id, { title: thread.title, actorRef: thread.actorRef }]),
    );
    return bucketByThread(rows, pricing, threadsById, { limit, includeUnknownThreads: false });
  }

  async usageTrend(range: GovernanceRange): Promise<UsageTrendPoint[]> {
    const pricing = await this.loadPricing();
    return bucketUsageTrend(await this.usageInRange(range), pricing);
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
