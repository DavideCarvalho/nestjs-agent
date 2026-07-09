import type {
  ActorSpendRow,
  AgentGovernanceQueries,
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
} from '@dudousxd/nestjs-agent-core';
import type { InMemoryAgentStore } from './in-memory-store.js';

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
}
