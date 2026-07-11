import type {
  ActorSpendRow,
  AgentGovernanceQueries,
  AgentPricingStore,
  GovernanceRange,
  GovernanceUsageInput,
  ModelPrice,
  ModelSpendRow,
  PendingApprovalRow,
  RecentRunRow,
  RunAgentBreakdownRow,
  RunErrorBreakdownRow,
  RunMetrics,
  RunTrendPoint,
  ThreadActivityRow,
  ThreadMeta,
  ThreadSpendRow,
  ToolCallActivityRow,
  ToolStatRow,
  UsageTrendPoint,
} from '@dudousxd/nestjs-agent-core';
import {
  bucketByActor,
  bucketByModel,
  bucketByThread,
  bucketUsageTrend,
  dayBoundsUtc,
} from '@dudousxd/nestjs-agent-core';
import type { EntityManager } from '@mikro-orm/core';
import { AgentMessage } from './entities/agent-message.entity';
import { AgentRun } from './entities/agent-run.entity';
import { AgentThread } from './entities/agent-thread.entity';
import { AgentTokenUsage } from './entities/agent-token-usage.entity';
import { AgentToolCall } from './entities/agent-tool-call.entity';

/** No error code recorded on a failed run (the caller didn't classify it). Groups those together. */
const UNCLASSIFIED_ERROR_CODE = 'unknown';
/** Bucket key for a run with no `agentName` (mirrors {@link RunAgentBreakdownRow}'s contract). */
const DEFAULT_AGENT_BUCKET = '(default)';

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

/** Map a MikroORM usage entity onto the shared bucketer input (thread via relation, day via `createdAt`). */
function toUsageInput(row: AgentTokenUsage): GovernanceUsageInput {
  return {
    modelId: row.modelId,
    actorRef: row.actorRef,
    threadId: row.thread.id,
    day: row.createdAt.toISOString().slice(0, 10),
    inputTokens: row.inputTokens,
    outputTokens: row.outputTokens,
    cacheWriteTokens: row.cacheWriteTokens,
    cacheReadTokens: row.cacheReadTokens,
    costUsd: row.costUsd,
  };
}

/**
 * {@link AgentGovernanceQueries} backed by MikroORM — the read/analytics half of the store SPI
 * (the write/thread half is {@link import('./mikro-orm-agent-store').MikroOrmAgentStore}). Cost is
 * the token ledger priced against the current prices from the injected {@link AgentPricingStore}
 * (`AGENT_PRICING_STORE`) — so a host that binds its own pricing store (e.g. its own curated pricing
 * table) controls the cost every governance surface reports, without this class knowing the source.
 * An unpriced model contributes 0 cost. Each operation runs on a fresh `em.fork()`, mirroring the
 * store, and aggregates in-process (like `quotaToday`) so the day-bucketing stays engine-portable.
 */
export class MikroOrmGovernanceQueries implements AgentGovernanceQueries {
  constructor(
    private readonly em: EntityManager,
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

  private async usageInRange(
    em: EntityManager,
    range: GovernanceRange,
  ): Promise<GovernanceUsageInput[]> {
    const { start, end } = dayBoundsUtc(range);
    const rows = await em.find(AgentTokenUsage, { createdAt: { $gte: start, $lte: end } });
    return rows.map(toUsageInput);
  }

  async spendByModel(range: GovernanceRange): Promise<ModelSpendRow[]> {
    const em = this.em.fork();
    const pricing = await this.loadPricing();
    return bucketByModel(await this.usageInRange(em, range), pricing);
  }

  async spendByActor(range: GovernanceRange): Promise<ActorSpendRow[]> {
    const em = this.em.fork();
    const pricing = await this.loadPricing();
    return bucketByActor(await this.usageInRange(em, range), pricing);
  }

  /**
   * Top threads by spend within the range, highest cost first, capped at `limit`. Usage rows for a
   * soft-deleted thread (`deletedAt` set) are excluded — the thread no longer surfaces as a
   * governance target even though its ledger rows survive.
   */
  async spendByThread(range: GovernanceRange, limit: number): Promise<ThreadSpendRow[]> {
    const em = this.em.fork();
    const pricing = await this.loadPricing();
    const rows = await this.usageInRange(em, range);
    const threadIds = [...new Set(rows.map((row) => row.threadId))];
    if (threadIds.length === 0) {
      return [];
    }
    const threads = await em.find(AgentThread, { id: { $in: threadIds }, deletedAt: null });
    const threadsById = new Map<string, ThreadMeta>(
      threads.map((thread) => [thread.id, { title: thread.title, actorRef: thread.actorRef }]),
    );
    return bucketByThread(rows, pricing, threadsById, { limit, includeUnknownThreads: false });
  }

  async usageTrend(range: GovernanceRange): Promise<UsageTrendPoint[]> {
    const em = this.em.fork();
    const pricing = await this.loadPricing();
    return bucketUsageTrend(await this.usageInRange(em, range), pricing);
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

  private async runsInRange(em: EntityManager, range: GovernanceRange): Promise<AgentRun[]> {
    const { start, end } = dayBoundsUtc(range);
    return em.find(AgentRun, { startedAt: { $gte: start, $lte: end } });
  }

  async runMetrics(range: GovernanceRange): Promise<RunMetrics> {
    const em = this.em.fork();
    const runs = await this.runsInRange(em, range);
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
    const em = this.em.fork();
    const runs = await this.runsInRange(em, range);
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
    const em = this.em.fork();
    const { start, end } = dayBoundsUtc(range);
    const runs = await em.find(AgentRun, {
      startedAt: { $gte: start, $lte: end },
      status: 'failed',
    });
    const byError = new Map<string, number>();
    for (const run of runs) {
      const errorCode = run.errorCode ?? UNCLASSIFIED_ERROR_CODE;
      byError.set(errorCode, (byError.get(errorCode) ?? 0) + 1);
    }
    const result: RunErrorBreakdownRow[] = [];
    for (const [errorCode, count] of byError) {
      result.push({ errorCode, count });
    }
    result.sort(
      (left, right) => right.count - left.count || left.errorCode.localeCompare(right.errorCode),
    );
    return result;
  }

  async runTrend(range: GovernanceRange): Promise<RunTrendPoint[]> {
    const em = this.em.fork();
    const runs = await this.runsInRange(em, range);
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
    const em = this.em.fork();
    const runs = await em.find(AgentRun, {}, { orderBy: { startedAt: 'desc', id: 'desc' }, limit });
    return runs.map((run) => ({
      runId: run.id,
      threadId: run.thread.id,
      actorRef: run.actorRef,
      agentName: run.agentName ?? null,
      status: run.status,
      durationMs: run.durationMs ?? null,
      errorCode: run.errorCode ?? null,
      errorMessage: run.errorMessage ?? null,
      retries: run.retries,
      startedAt: run.startedAt.toISOString(),
      promptHash: run.promptHash ?? null,
    }));
  }

  /**
   * Tool calls sitting `pending_approval`, oldest first (an inbox drains from the back), joined
   * through their message to the owning thread for title/actorRef and to the message itself for
   * `agentName` (null when the message carries none).
   */
  async pendingApprovals(limit: number): Promise<PendingApprovalRow[]> {
    const em = this.em.fork();
    const rows = await em.find(
      AgentToolCall,
      { status: 'pending_approval' },
      {
        orderBy: { createdAt: 'asc', id: 'asc' },
        limit,
        populate: ['message', 'message.thread'],
      },
    );
    return rows.map((toolCall) => ({
      toolCallId: toolCall.id,
      toolName: toolCall.toolName,
      input: toolCall.input,
      threadId: toolCall.message.thread.id,
      threadTitle: toolCall.message.thread.title,
      actorRef: toolCall.message.thread.actorRef,
      agentName: toolCall.message.agentName ?? null,
      requestedAt: toolCall.createdAt.toISOString(),
    }));
  }

  /**
   * Per-tool call/failure/rejection/latency rollup over the range, highest call count first.
   * `p95ExecutionMs` is computed over calls that recorded a non-null `executionMs` (regardless of
   * their final status); `null` when none did.
   */
  async toolStats(range: GovernanceRange): Promise<ToolStatRow[]> {
    const em = this.em.fork();
    const { start, end } = dayBoundsUtc(range);
    const calls = await em.find(AgentToolCall, { createdAt: { $gte: start, $lte: end } });
    const byTool = new Map<
      string,
      {
        toolName: string;
        toolType: string;
        calls: number;
        failed: number;
        rejected: number;
        executionMs: number[];
      }
    >();
    for (const call of calls) {
      const key = `${call.toolName} ${call.toolType}`;
      const bucket = byTool.get(key) ?? {
        toolName: call.toolName,
        toolType: call.toolType,
        calls: 0,
        failed: 0,
        rejected: 0,
        executionMs: [],
      };
      bucket.calls += 1;
      bucket.failed += call.status === 'failed' ? 1 : 0;
      bucket.rejected += call.status === 'rejected' ? 1 : 0;
      if (call.executionMs != null) {
        bucket.executionMs.push(call.executionMs);
      }
      byTool.set(key, bucket);
    }
    const result: ToolStatRow[] = [];
    for (const bucket of byTool.values()) {
      bucket.executionMs.sort((left, right) => left - right);
      result.push({
        toolName: bucket.toolName,
        toolType: bucket.toolType,
        calls: bucket.calls,
        failed: bucket.failed,
        rejected: bucket.rejected,
        p95ExecutionMs: percentileMs(bucket.executionMs, 0.95),
      });
    }
    result.sort(
      (left, right) => right.calls - left.calls || left.toolName.localeCompare(right.toolName),
    );
    return result;
  }
}
