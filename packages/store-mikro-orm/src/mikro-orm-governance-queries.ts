import type {
  ActorSpendRow,
  AgentGovernanceQueries,
  AgentPricingStore,
  ApprovalWhere,
  GovernancePage,
  GovernancePageQuery,
  GovernanceRange,
  GovernanceRunDetail,
  GovernanceThreadDetail,
  GovernanceThreadDetailQuery,
  GovernanceUsageInput,
  ModelPrice,
  ModelSpendRow,
  PendingApprovalRow,
  RecentRunRow,
  RunAgentBreakdownRow,
  RunErrorBreakdownRow,
  RunMetrics,
  RunToolCallRow,
  RunTrendPoint,
  RunWhere,
  ThreadActivityRow,
  ThreadMessageRow,
  ThreadMeta,
  ThreadSpendRow,
  ThreadWhere,
  ToolCallActivityRow,
  ToolCallWhere,
  ToolStatRow,
  UsageTrendPoint,
} from '@dudousxd/nestjs-agent-core';
import {
  bucketByActor,
  bucketByModel,
  bucketByThread,
  bucketUsageTrend,
  dayBoundsUtc,
  rollupThreadUsage,
  truncateDetailContent,
} from '@dudousxd/nestjs-agent-core';
import type { ToolCallStatus, ToolKind } from '@dudousxd/nestjs-agent-core';
import type { EntityManager } from '@mikro-orm/core';
import { sql } from '@mikro-orm/core';
import { AgentMessage } from './entities/agent-message.entity';
import type { AgentRunStatus } from './entities/agent-run.entity';
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

// The paged where-builders below narrow a wire-typed `string` filter value down to the entity's
// literal-union column type before it's assigned into a MikroORM filter object (an unnarrowed
// `string` isn't assignable to e.g. `AgentToolCall['status']`). An unrecognized value can never
// match a row anyway (the column only ever holds these literals), so the paged method short-circuits
// to an empty page instead of querying with a value that would trivially return nothing.
const TOOL_CALL_STATUSES: readonly string[] = [
  'auto_executed',
  'pending_approval',
  'executed',
  'rejected',
  'failed',
];
function isToolCallStatus(value: string): value is ToolCallStatus {
  return TOOL_CALL_STATUSES.includes(value);
}

const TOOL_KINDS: readonly string[] = ['read', 'action', 'agent'];
function isToolKind(value: string): value is ToolKind {
  return TOOL_KINDS.includes(value);
}

const RUN_STATUSES: readonly string[] = ['running', 'completed', 'failed'];
function isRunStatus(value: string): value is AgentRunStatus {
  return RUN_STATUSES.includes(value);
}

/** Inclusive UTC day start, reusing {@link dayBoundsUtc}'s date math so both bounds parse identically. */
function dayStartUtc(day: string): Date {
  return dayBoundsUtc({ fromDay: day, toDay: day }).start;
}

/** Inclusive UTC day end, reusing {@link dayBoundsUtc}'s date math so both bounds parse identically. */
function dayEndUtc(day: string): Date {
  return dayBoundsUtc({ fromDay: day, toDay: day }).end;
}

/** An empty page for the given query's page/pageSize — the shape every paged read falls back to. */
function emptyPage<TRow>(query: GovernancePageQuery<unknown>): GovernancePage<TRow> {
  return { rows: [], total: 0, page: query.page, pageSize: query.pageSize };
}

/** Map a run entity onto the SPI row. Shared by `recentRuns`/`runsPage`/`runDetail`/`threadDetail`. */
function toRecentRunRow(run: AgentRun): RecentRunRow {
  return {
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
  };
}

/** Map a tool-call entity onto the run drill-down's row (execution outcome, not activity-feed shape). */
function toRunToolCallRow(toolCall: AgentToolCall): RunToolCallRow {
  return {
    toolCallId: toolCall.id,
    toolName: toolCall.toolName,
    toolType: toolCall.toolType,
    status: toolCall.status,
    executionMs: toolCall.executionMs ?? null,
    executedByRef: toolCall.executedByRef ?? null,
    error: toolCall.error ?? null,
    createdAt: toolCall.createdAt.toISOString(),
  };
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
      runId: toolCall.runId ?? null,
    }));
  }

  /**
   * Message counts and token totals for a whole set of threads in TWO queries rather than two per
   * thread. Both reads are narrowed to the columns the rollup needs and bounded by the caller's
   * thread ids, so a 200-row page costs two statements instead of four hundred round trips.
   *
   * Counting happens in-process rather than as a `GROUP BY` because the SPI's contract is engine-
   * portable and this class only holds the driver-agnostic `EntityManager` (no QueryBuilder); the
   * row volume was already being fetched by the per-thread loop this replaces.
   */
  private async threadRollups(
    em: EntityManager,
    threadIds: string[],
  ): Promise<Map<string, { messageCount: number; totalTokens: number }>> {
    const rollups = new Map<string, { messageCount: number; totalTokens: number }>(
      threadIds.map((threadId) => [threadId, { messageCount: 0, totalTokens: 0 }]),
    );
    if (threadIds.length === 0) {
      return rollups;
    }
    const messages = await em.find(
      AgentMessage,
      { thread: { $in: threadIds } },
      { fields: ['thread'] },
    );
    for (const message of messages) {
      const bucket = rollups.get(message.thread.id);
      if (bucket !== undefined) {
        bucket.messageCount += 1;
      }
    }
    const usageRows = await em.find(
      AgentTokenUsage,
      { thread: { $in: threadIds } },
      { fields: ['thread', 'inputTokens', 'outputTokens'] },
    );
    for (const row of usageRows) {
      const bucket = rollups.get(row.thread.id);
      if (bucket !== undefined) {
        bucket.totalTokens += row.inputTokens + row.outputTokens;
      }
    }
    return rollups;
  }

  /** Decorate an ordered thread list with its batched rollups, preserving the incoming order. */
  private async toThreadActivityRows(
    em: EntityManager,
    threads: AgentThread[],
  ): Promise<ThreadActivityRow[]> {
    const rollups = await this.threadRollups(
      em,
      threads.map((thread) => thread.id),
    );
    return threads.map((thread) => {
      const rollup = rollups.get(thread.id);
      return {
        threadId: thread.id,
        title: thread.title,
        actorRef: thread.actorRef,
        messageCount: rollup?.messageCount ?? 0,
        totalTokens: rollup?.totalTokens ?? 0,
        lastActivityAt: thread.updatedAt.toISOString(),
      };
    });
  }

  async recentThreads(limit: number): Promise<ThreadActivityRow[]> {
    const em = this.em.fork();
    const threads = await em.find(
      AgentThread,
      { deletedAt: null },
      { orderBy: { updatedAt: 'desc', id: 'desc' }, limit },
    );
    return this.toThreadActivityRows(em, threads);
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
    return runs.map(toRecentRunRow);
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
      runId: toolCall.runId ?? null,
    }));
  }

  /**
   * Per-tool call/failure/rejection/latency rollup over the range, highest call count first.
   * `p50ExecutionMs`/`p95ExecutionMs` are computed over calls that recorded a non-null `executionMs`
   * (regardless of their final status); both `null` when none did. Percentiles are taken in-process
   * off the sorted sample rather than in SQL: MySQL has no `PERCENTILE_CONT`, and this class supports
   * every dialect MikroORM does, so one portable implementation beats three dialect-specific ones.
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
        p50ExecutionMs: percentileMs(bucket.executionMs, 0.5),
        p95ExecutionMs: percentileMs(bucket.executionMs, 0.95),
      });
    }
    result.sort(
      (left, right) => right.calls - left.calls || left.toolName.localeCompare(right.toolName),
    );
    return result;
  }

  /**
   * Paged, filterable tool-call activity, newest-first (same ordering as {@link recentToolCalls}).
   * `toolType`/`status` values outside the known literals can never match a row — short-circuits to
   * an empty page rather than issuing a query. `threadId` filters through the `message` relation
   * (a tool call has no direct `threadId` column).
   */
  async toolCallsPage(
    query: GovernancePageQuery<ToolCallWhere>,
  ): Promise<GovernancePage<ToolCallActivityRow>> {
    const filters = query.where;
    if (filters?.status !== undefined && !isToolCallStatus(filters.status)) {
      return emptyPage(query);
    }
    if (filters?.toolType !== undefined && !isToolKind(filters.toolType)) {
      return emptyPage(query);
    }
    const em = this.em.fork();
    const where = {
      ...(filters?.toolName !== undefined ? { toolName: filters.toolName } : {}),
      ...(filters?.toolType !== undefined && isToolKind(filters.toolType)
        ? { toolType: filters.toolType }
        : {}),
      ...(filters?.status !== undefined && isToolCallStatus(filters.status)
        ? { status: filters.status }
        : {}),
      ...(filters?.threadId !== undefined ? { message: { thread: filters.threadId } } : {}),
      ...(filters?.fromDay !== undefined || filters?.toDay !== undefined
        ? {
            createdAt: {
              ...(filters.fromDay !== undefined ? { $gte: dayStartUtc(filters.fromDay) } : {}),
              ...(filters.toDay !== undefined ? { $lte: dayEndUtc(filters.toDay) } : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await em.findAndCount(AgentToolCall, where, {
      orderBy: { createdAt: 'desc', id: 'desc' },
      limit: query.pageSize,
      offset: (query.page - 1) * query.pageSize,
      populate: ['message'],
    });
    return {
      rows: rows.map((toolCall) => ({
        toolCallId: toolCall.id,
        toolName: toolCall.toolName,
        toolType: toolCall.toolType,
        status: toolCall.status,
        threadId: toolCall.message.thread.id,
        createdAt: toolCall.createdAt.toISOString(),
        runId: toolCall.runId ?? null,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * Paged, filterable thread activity, newest-first (same ordering as {@link recentThreads}).
   * `title` is a case-insensitive substring match via `sql.lower` (portable across MySQL/Postgres/
   * SQLite, regardless of the entity's own collation). Soft-deleted threads are excluded, mirroring
   * `recentThreads`.
   */
  async threadsPage(
    query: GovernancePageQuery<ThreadWhere>,
  ): Promise<GovernancePage<ThreadActivityRow>> {
    const filters = query.where;
    const em = this.em.fork();
    const where = {
      deletedAt: null,
      ...(filters?.actorRef !== undefined ? { actorRef: filters.actorRef } : {}),
      ...(filters?.title !== undefined
        ? { [sql.lower('title')]: { $like: `%${filters.title.toLowerCase()}%` } }
        : {}),
      ...(filters?.fromDay !== undefined || filters?.toDay !== undefined
        ? {
            updatedAt: {
              ...(filters?.fromDay !== undefined ? { $gte: dayStartUtc(filters.fromDay) } : {}),
              ...(filters?.toDay !== undefined ? { $lte: dayEndUtc(filters.toDay) } : {}),
            },
          }
        : {}),
    };
    const [threads, total] = await em.findAndCount(AgentThread, where, {
      orderBy: { updatedAt: 'desc', id: 'desc' },
      limit: query.pageSize,
      offset: (query.page - 1) * query.pageSize,
    });
    const rows = await this.toThreadActivityRows(em, threads);
    return { rows, total, page: query.page, pageSize: query.pageSize };
  }

  /**
   * Paged, filterable run activity, newest-first (same ordering as {@link recentRuns}). `status`
   * values outside the known literals can never match a row — short-circuits to an empty page.
   */
  async runsPage(query: GovernancePageQuery<RunWhere>): Promise<GovernancePage<RecentRunRow>> {
    const filters = query.where;
    if (filters?.status !== undefined && !isRunStatus(filters.status)) {
      return emptyPage(query);
    }
    const em = this.em.fork();
    const where = {
      ...(filters?.agentName !== undefined ? { agentName: filters.agentName } : {}),
      ...(filters?.status !== undefined && isRunStatus(filters.status)
        ? { status: filters.status }
        : {}),
      ...(filters?.errorCode !== undefined ? { errorCode: filters.errorCode } : {}),
      ...(filters?.threadId !== undefined ? { thread: filters.threadId } : {}),
      ...(filters?.fromDay !== undefined || filters?.toDay !== undefined
        ? {
            startedAt: {
              ...(filters.fromDay !== undefined ? { $gte: dayStartUtc(filters.fromDay) } : {}),
              ...(filters.toDay !== undefined ? { $lte: dayEndUtc(filters.toDay) } : {}),
            },
          }
        : {}),
    };
    const [runs, total] = await em.findAndCount(AgentRun, where, {
      orderBy: { startedAt: 'desc', id: 'desc' },
      limit: query.pageSize,
      offset: (query.page - 1) * query.pageSize,
    });
    return { rows: runs.map(toRecentRunRow), total, page: query.page, pageSize: query.pageSize };
  }

  /**
   * Paged, filterable approvals inbox, oldest first — the same ordering as {@link pendingApprovals},
   * now with the `total` that method structurally cannot report. `threadId`/`actorRef` filter through
   * the `message → thread` relation, `agentName` through the message; day bounds apply to when the
   * approval was requested (`createdAt`).
   *
   * The order is TOTAL (`createdAt asc, id asc`, and `id` is the primary key), so no row can land on
   * two pages or on none for a given snapshot. Ascending order also means a newly requested approval
   * appends past the last page instead of shifting the page an operator is currently reading.
   */
  async approvalsPage(
    query: GovernancePageQuery<ApprovalWhere>,
  ): Promise<GovernancePage<PendingApprovalRow>> {
    const filters = query.where ?? {};
    const threadWhere = {
      ...(filters.threadId !== undefined ? { id: filters.threadId } : {}),
      ...(filters.actorRef !== undefined ? { actorRef: filters.actorRef } : {}),
    };
    const messageWhere = {
      ...(filters.agentName !== undefined ? { agentName: filters.agentName } : {}),
      ...(Object.keys(threadWhere).length > 0 ? { thread: threadWhere } : {}),
    };
    const em = this.em.fork();
    const where = {
      status: 'pending_approval' as const,
      ...(filters.toolName !== undefined ? { toolName: filters.toolName } : {}),
      ...(Object.keys(messageWhere).length > 0 ? { message: messageWhere } : {}),
      ...(filters.fromDay !== undefined || filters.toDay !== undefined
        ? {
            createdAt: {
              ...(filters.fromDay !== undefined ? { $gte: dayStartUtc(filters.fromDay) } : {}),
              ...(filters.toDay !== undefined ? { $lte: dayEndUtc(filters.toDay) } : {}),
            },
          }
        : {}),
    };
    const [rows, total] = await em.findAndCount(AgentToolCall, where, {
      orderBy: { createdAt: 'asc', id: 'asc' },
      limit: query.pageSize,
      offset: (query.page - 1) * query.pageSize,
      populate: ['message', 'message.thread'],
    });
    return {
      rows: rows.map((toolCall) => ({
        toolCallId: toolCall.id,
        toolName: toolCall.toolName,
        input: toolCall.input,
        threadId: toolCall.message.thread.id,
        threadTitle: toolCall.message.thread.title,
        actorRef: toolCall.message.thread.actorRef,
        agentName: toolCall.message.agentName ?? null,
        requestedAt: toolCall.createdAt.toISOString(),
        runId: toolCall.runId ?? null,
      })),
      total,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * One run, its owning thread's headline and its tool calls — TWO queries regardless of how many
   * tools the run called. `toolCalls` comes off `agent_tool_call.run_id`, so a run recorded before
   * that column was written reports none.
   */
  async runDetail(runId: string): Promise<GovernanceRunDetail | null> {
    const em = this.em.fork();
    const run = await em.findOne(AgentRun, { id: runId }, { populate: ['thread'] });
    if (run === null) {
      return null;
    }
    const toolCalls = await em.find(
      AgentToolCall,
      { runId },
      { orderBy: { createdAt: 'asc', id: 'asc' } },
    );
    return {
      run: toRecentRunRow(run),
      thread: {
        threadId: run.thread.id,
        title: run.thread.title,
        actorRef: run.thread.actorRef,
        deleted: run.thread.deletedAt != null,
      },
      toolCalls: toolCalls.map(toRunToolCallRow),
    };
  }

  /**
   * One thread with its lifetime usage rollup, its newest runs and its newest messages. A fixed six
   * queries (thread, usage, message count, message page, that page's tool calls, runs+count) — the
   * per-message tool-call counts are ONE batched read over the returned message ids, not one per
   * message. Soft-deleted threads are returned with `deleted: true`; an audit still needs them.
   */
  async threadDetail(query: GovernanceThreadDetailQuery): Promise<GovernanceThreadDetail | null> {
    const em = this.em.fork();
    const thread = await em.findOne(AgentThread, { id: query.threadId });
    if (thread === null) {
      return null;
    }
    const pricing = await this.loadPricing();
    const usageRows = await em.find(AgentTokenUsage, { thread });
    const usage = rollupThreadUsage(usageRows.map(toUsageInput), pricing);
    const messageCount = await em.count(AgentMessage, { thread });
    const messages = await em.find(
      AgentMessage,
      { thread },
      { orderBy: { createdAt: 'desc', id: 'desc' }, limit: query.messageLimit },
    );
    const toolCallCounts = await this.toolCallCountsByMessage(
      em,
      messages.map((message) => message.id),
    );
    const [runs, runTotal] = await em.findAndCount(
      AgentRun,
      { thread },
      { orderBy: { startedAt: 'desc', id: 'desc' }, limit: query.runLimit },
    );
    return {
      thread: {
        threadId: thread.id,
        title: thread.title,
        actorRef: thread.actorRef,
        messageCount,
        totalTokens: usage.totalTokens,
        lastActivityAt: thread.updatedAt.toISOString(),
      },
      deleted: thread.deletedAt != null,
      usage,
      runs: runs.map(toRecentRunRow),
      runTotal,
      messages: messages.map((message): ThreadMessageRow => {
        const { content, truncated } = truncateDetailContent(message.content);
        return {
          messageId: message.id,
          role: message.role,
          content,
          truncated,
          agentName: message.agentName ?? null,
          toolCallCount: toolCallCounts.get(message.id) ?? 0,
          createdAt: message.createdAt.toISOString(),
        };
      }),
    };
  }

  /** Tool-call counts for a set of messages in ONE query — the detail view's no-N+1 guarantee. */
  private async toolCallCountsByMessage(
    em: EntityManager,
    messageIds: string[],
  ): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (messageIds.length === 0) {
      return counts;
    }
    const toolCalls = await em.find(
      AgentToolCall,
      { message: { $in: messageIds } },
      { fields: ['message'] },
    );
    for (const toolCall of toolCalls) {
      counts.set(toolCall.message.id, (counts.get(toolCall.message.id) ?? 0) + 1);
    }
    return counts;
  }
}
