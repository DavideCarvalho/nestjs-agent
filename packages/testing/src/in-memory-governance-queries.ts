import type {
  ActorSpendRow,
  AgentGovernanceQueries,
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
} from '@dudousxd/nestjs-agent-core';
import type { GovernanceRunRow, InMemoryAgentStore } from './in-memory-store.js';

/** No error code recorded on a failed run (the caller didn't classify it). Groups those together. */
const UNCLASSIFIED_ERROR_CODE = 'unknown';
/** Bucket key for a run with no `agentName` (mirrors {@link RunAgentBreakdownRow}'s contract). */
const DEFAULT_AGENT_BUCKET = '(default)';

/**
 * MySQL-compatible percentile (no `PERCENTILE_CONT`): index into an ascending-sorted array by
 * offset. `null` when there are no settled durations in range. Mirrors the SQL adapter's math so
 * both report identically.
 */
function percentileMs(sortedDurationsMs: number[], p: number): number | null {
  if (sortedDurationsMs.length === 0) {
    return null;
  }
  const offset = Math.min(sortedDurationsMs.length - 1, Math.floor(p * sortedDurationsMs.length));
  return sortedDurationsMs[offset] ?? null;
}

/**
 * The current per-1M token prices for one model; cache rates fall back to the input rate. Re-exported
 * alias of the core {@link ModelPrice} so the shared cost formula is the single source of truth.
 */
export type InMemoryModelPrice = ModelPrice;

/**
 * A fully in-memory {@link AgentGovernanceQueries} for unit tests and the offline demo. Aggregates
 * the usage/tool-call/thread rows recorded on an {@link InMemoryAgentStore} through the shared core
 * bucketers. Pricing is an optional map keyed by `modelId`; omit it (default empty) for a zero-cost
 * read-model that still reports token usage. Mirrors the SQL adapters' cost formula and inclusive-day
 * semantics because it runs the exact same helpers.
 */
export class InMemoryGovernanceQueries implements AgentGovernanceQueries {
  constructor(
    private readonly store: InMemoryAgentStore,
    private readonly pricing: ReadonlyMap<string, InMemoryModelPrice> = new Map(),
  ) {}

  /** The recorded usage rows within the inclusive day range, already in the shared bucketer shape. */
  private usageInRange(range: GovernanceRange): GovernanceUsageInput[] {
    return this.store
      .governanceUsage()
      .filter((row) => row.day >= range.fromDay && row.day <= range.toDay);
  }

  /** The recorded run rows within the inclusive day range (bucketed by `startedAt`'s UTC day). */
  private runsInRange(range: GovernanceRange): GovernanceRunRow[] {
    return this.store.governanceRuns().filter((row) => {
      const day = row.startedAt.slice(0, 10);
      return day >= range.fromDay && day <= range.toDay;
    });
  }

  async spendByModel(range: GovernanceRange): Promise<ModelSpendRow[]> {
    return bucketByModel(this.usageInRange(range), this.pricing);
  }

  async spendByActor(range: GovernanceRange): Promise<ActorSpendRow[]> {
    return bucketByActor(this.usageInRange(range), this.pricing);
  }

  async spendByThread(range: GovernanceRange, limit: number): Promise<ThreadSpendRow[]> {
    const threadsById = new Map<string, ThreadMeta>(
      this.store
        .governanceThreads()
        .map((thread) => [thread.threadId, { title: thread.title, actorRef: thread.actorRef }]),
    );
    return bucketByThread(this.usageInRange(range), this.pricing, threadsById, {
      limit,
      includeUnknownThreads: true,
    });
  }

  async usageTrend(range: GovernanceRange): Promise<UsageTrendPoint[]> {
    return bucketUsageTrend(this.usageInRange(range), this.pricing);
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

  async runMetrics(range: GovernanceRange): Promise<RunMetrics> {
    const runs = this.runsInRange(range);
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
      if ((run.status === 'completed' || run.status === 'failed') && run.durationMs !== undefined) {
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
    const byAgent = new Map<string, { runs: number; failed: number; retries: number }>();
    for (const run of this.runsInRange(range)) {
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
    const byError = new Map<string, number>();
    for (const run of this.runsInRange(range)) {
      if (run.status !== 'failed') {
        continue;
      }
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
    const byDay = new Map<string, { runs: number; failed: number }>();
    for (const run of this.runsInRange(range)) {
      const day = run.startedAt.slice(0, 10);
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
    return [...this.store.governanceRuns()]
      .sort((left, right) => right.startedAt.localeCompare(left.startedAt))
      .slice(0, limit)
      .map((run) => ({
        runId: run.runId,
        threadId: run.threadId,
        actorRef: run.actorRef,
        agentName: run.agentName ?? null,
        status: run.status,
        durationMs: run.durationMs ?? null,
        errorCode: run.errorCode ?? null,
        errorMessage: run.errorMessage ?? null,
        retries: run.retries,
        startedAt: run.startedAt,
      }));
  }
}
