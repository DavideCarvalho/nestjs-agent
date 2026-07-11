import type {
  ActorSpendRow,
  AgentGovernanceQueries,
  AgentPricingStore,
  GovernanceRange,
  GovernanceUsageInput,
  ModelPrice,
  ModelSpendRow,
  RecentRunRow,
  RunAgentBreakdownRow,
  RunErrorBreakdownRow,
  RunMetrics,
  RunTrendPoint,
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
  agentRun,
  agentThread,
  agentTokenUsage,
  agentToolCall,
} from './schema.js';

/** No error code recorded on a failed run (the caller didn't classify it). Groups those together. */
const UNCLASSIFIED_ERROR_CODE = 'unknown';
/** Bucket key for a run with no `agentName` (mirrors {@link RunAgentBreakdownRow}'s contract). */
const DEFAULT_AGENT_BUCKET = '(default)';

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
 * MySQL-compatible percentile (no `PERCENTILE_CONT`): index into an ascending-sorted array by
 * offset. `null` when there are no settled durations in range. Shared by every reliability query
 * that reports p50/p95 so the SQL and in-memory adapters compute identically.
 */
function percentileMs(sortedDurationsMs: number[], p: number): number | null {
  if (sortedDurationsMs.length === 0) {
    return null;
  }
  const offset = Math.min(sortedDurationsMs.length - 1, Math.floor(p * sortedDurationsMs.length));
  return sortedDurationsMs[offset] ?? null;
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

  private async runsInRange(range: GovernanceRange): Promise<(typeof agentRun.$inferSelect)[]> {
    const { start, end } = dayBoundsUtc(range);
    return this.db
      .select()
      .from(agentRun)
      .where(and(gte(agentRun.startedAt, start), lte(agentRun.startedAt, end)));
  }

  async runMetrics(range: GovernanceRange): Promise<RunMetrics> {
    const runs = await this.runsInRange(range);
    let completed = 0;
    let failed = 0;
    let retries = 0;
    const settledDurationsMs: number[] = [];
    for (const run of runs) {
      if (run.status === 'completed') {
        completed += 1;
      } else if (run.status === 'failed') {
        failed += 1;
      }
      retries += run.retries;
      if ((run.status === 'completed' || run.status === 'failed') && run.durationMs != null) {
        settledDurationsMs.push(run.durationMs);
      }
    }
    settledDurationsMs.sort((left, right) => left - right);
    return {
      runs: runs.length,
      completed,
      failed,
      successRate: runs.length === 0 ? 0 : completed / runs.length,
      retries,
      durationP50Ms: percentileMs(settledDurationsMs, 0.5),
      durationP95Ms: percentileMs(settledDurationsMs, 0.95),
    };
  }

  async runsByAgent(range: GovernanceRange): Promise<RunAgentBreakdownRow[]> {
    const runs = await this.runsInRange(range);
    const byAgent = new Map<string, { runs: number; failed: number; retries: number }>();
    for (const run of runs) {
      const agentName = run.agentName ?? DEFAULT_AGENT_BUCKET;
      const bucket = byAgent.get(agentName) ?? { runs: 0, failed: 0, retries: 0 };
      bucket.runs += 1;
      bucket.failed += run.status === 'failed' ? 1 : 0;
      bucket.retries += run.retries;
      byAgent.set(agentName, bucket);
    }
    const result: RunAgentBreakdownRow[] = [];
    for (const [agentName, bucket] of byAgent) {
      result.push({ agentName, ...bucket });
    }
    result.sort(
      (left, right) => right.runs - left.runs || left.agentName.localeCompare(right.agentName),
    );
    return result;
  }

  async runErrors(range: GovernanceRange): Promise<RunErrorBreakdownRow[]> {
    const { start, end } = dayBoundsUtc(range);
    const runs = await this.db
      .select()
      .from(agentRun)
      .where(
        and(
          gte(agentRun.startedAt, start),
          lte(agentRun.startedAt, end),
          eq(agentRun.status, 'failed'),
        ),
      );
    const byError = new Map<string, number>();
    for (const run of runs) {
      const errorCode = run.errorCode ?? UNCLASSIFIED_ERROR_CODE;
      byError.set(errorCode, (byError.get(errorCode) ?? 0) + 1);
    }
    const result: RunErrorBreakdownRow[] = [];
    for (const [errorCode, errorCount] of byError) {
      result.push({ errorCode, count: errorCount });
    }
    result.sort(
      (left, right) => right.count - left.count || left.errorCode.localeCompare(right.errorCode),
    );
    return result;
  }

  async runTrend(range: GovernanceRange): Promise<RunTrendPoint[]> {
    const runs = await this.runsInRange(range);
    const byDay = new Map<string, { runs: number; failed: number }>();
    for (const run of runs) {
      const day = run.startedAt.toISOString().slice(0, 10);
      const bucket = byDay.get(day) ?? { runs: 0, failed: 0 };
      bucket.runs += 1;
      bucket.failed += run.status === 'failed' ? 1 : 0;
      byDay.set(day, bucket);
    }
    const result: RunTrendPoint[] = [];
    for (const [day, bucket] of byDay) {
      result.push({ day, ...bucket });
    }
    result.sort((left, right) => left.day.localeCompare(right.day));
    return result;
  }

  async recentRuns(limit: number): Promise<RecentRunRow[]> {
    const runs = await this.db
      .select()
      .from(agentRun)
      .orderBy(desc(agentRun.startedAt), desc(agentRun.id))
      .limit(limit);
    return runs.map((run) => ({
      runId: run.id,
      threadId: run.threadId,
      actorRef: run.actorRef,
      agentName: run.agentName ?? null,
      status: run.status,
      durationMs: run.durationMs ?? null,
      errorCode: run.errorCode ?? null,
      errorMessage: run.errorMessage ?? null,
      retries: run.retries,
      startedAt: run.startedAt.toISOString(),
    }));
  }
}
