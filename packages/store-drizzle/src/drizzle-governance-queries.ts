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
  ToolCallStatus,
  ToolCallWhere,
  ToolKind,
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
import { and, asc, count, desc, eq, gte, inArray, isNull, like, lte, sql, sum } from 'drizzle-orm';
import {
  type AgentDrizzleDb,
  type AgentRunStatus,
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

// The paged where-builders below narrow a wire-typed `string` filter value down to the schema
// column's literal-union `$type<...>()` before it's used in an `eq()` comparison (an unnarrowed
// `string` isn't assignable to e.g. `agentToolCall.status`'s type). An unrecognized value can never
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

/** Map a run row onto the SPI row. Shared by `recentRuns`/`runsPage`/`runDetail`/`threadDetail`. */
function toRecentRunRow(run: typeof agentRun.$inferSelect): RecentRunRow {
  return {
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
    promptHash: run.promptHash ?? null,
  };
}

/** Map a tool-call row onto the run drill-down's row (execution outcome, not activity-feed shape). */
function toRunToolCallRow(toolCall: typeof agentToolCall.$inferSelect): RunToolCallRow {
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
        runId: agentToolCall.runId,
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
      runId: row.runId,
    }));
  }

  /**
   * Message counts and token totals for a whole set of threads in TWO grouped queries, not two per
   * thread — a 200-row page used to cost four hundred round trips. Mirrors the MikroORM adapter's
   * `threadRollups`, which reaches the same numbers without a QueryBuilder.
   */
  private async threadRollups(
    threadIds: string[],
  ): Promise<Map<string, { messageCount: number; totalTokens: number }>> {
    const rollups = new Map<string, { messageCount: number; totalTokens: number }>(
      threadIds.map((threadId) => [threadId, { messageCount: 0, totalTokens: 0 }]),
    );
    if (threadIds.length === 0) {
      return rollups;
    }
    const messageCounts = await this.db
      .select({ threadId: agentMessage.threadId, value: count() })
      .from(agentMessage)
      .where(inArray(agentMessage.threadId, threadIds))
      .groupBy(agentMessage.threadId);
    for (const row of messageCounts) {
      const bucket = rollups.get(row.threadId);
      if (bucket !== undefined) {
        bucket.messageCount = row.value;
      }
    }
    const usageTotals = await this.db
      .select({
        threadId: agentTokenUsage.threadId,
        inputTokens: sum(agentTokenUsage.inputTokens),
        outputTokens: sum(agentTokenUsage.outputTokens),
      })
      .from(agentTokenUsage)
      .where(inArray(agentTokenUsage.threadId, threadIds))
      .groupBy(agentTokenUsage.threadId);
    for (const row of usageTotals) {
      const bucket = rollups.get(row.threadId);
      if (bucket !== undefined) {
        // Drizzle types SUM() as string|null (a dialect can widen it past a JS number).
        bucket.totalTokens = Number(row.inputTokens ?? 0) + Number(row.outputTokens ?? 0);
      }
    }
    return rollups;
  }

  /** Decorate an ordered thread list with its batched rollups, preserving the incoming order. */
  private async toThreadActivityRows(
    threads: (typeof agentThread.$inferSelect)[],
  ): Promise<ThreadActivityRow[]> {
    const rollups = await this.threadRollups(threads.map((thread) => thread.id));
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
    const threads = await this.db
      .select()
      .from(agentThread)
      .where(isNull(agentThread.deletedAt))
      .orderBy(desc(agentThread.updatedAt), desc(agentThread.id))
      .limit(limit);
    return this.toThreadActivityRows(threads);
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
    return runs.map(toRecentRunRow);
  }

  /**
   * Tool calls sitting `pending_approval`, oldest first (an inbox drains from the back), joined
   * through their message to the owning thread for title/actorRef and to the message itself for
   * `agentName` (null when the message carries none).
   */
  async pendingApprovals(limit: number): Promise<PendingApprovalRow[]> {
    const rows = await this.db
      .select({
        toolCallId: agentToolCall.id,
        toolName: agentToolCall.toolName,
        input: agentToolCall.input,
        threadId: agentThread.id,
        threadTitle: agentThread.title,
        actorRef: agentThread.actorRef,
        agentName: agentMessage.agentName,
        requestedAt: agentToolCall.createdAt,
        runId: agentToolCall.runId,
      })
      .from(agentToolCall)
      .innerJoin(agentMessage, eq(agentToolCall.messageId, agentMessage.id))
      .innerJoin(agentThread, eq(agentMessage.threadId, agentThread.id))
      .where(eq(agentToolCall.status, 'pending_approval'))
      .orderBy(agentToolCall.createdAt, agentToolCall.id)
      .limit(limit);
    return rows.map((row) => ({
      toolCallId: row.toolCallId,
      toolName: row.toolName,
      input: row.input,
      threadId: row.threadId,
      threadTitle: row.threadTitle,
      actorRef: row.actorRef,
      agentName: row.agentName ?? null,
      requestedAt: row.requestedAt.toISOString(),
      runId: row.runId,
    }));
  }

  /**
   * Per-tool call/failure/rejection/latency rollup over the range, highest call count first.
   * `p50ExecutionMs`/`p95ExecutionMs` are computed over calls that recorded a non-null `executionMs`
   * (regardless of their final status); both `null` when none did. Percentiles are taken in-process
   * off the sorted sample rather than in SQL, matching the MikroORM adapter — MySQL has no
   * `PERCENTILE_CONT` and one portable implementation beats three dialect-specific ones.
   */
  async toolStats(range: GovernanceRange): Promise<ToolStatRow[]> {
    const { start, end } = dayBoundsUtc(range);
    const calls = await this.db
      .select()
      .from(agentToolCall)
      .where(and(gte(agentToolCall.createdAt, start), lte(agentToolCall.createdAt, end)));
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
      const key = `${call.toolName} ${call.toolType}`;
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
   * an empty page rather than issuing a query. Joins `agent_message` unconditionally (like
   * `recentToolCalls`) to resolve `threadId` and to support the `threadId` filter.
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
    const whereClause = and(
      filters?.toolName !== undefined ? eq(agentToolCall.toolName, filters.toolName) : undefined,
      filters?.toolType !== undefined && isToolKind(filters.toolType)
        ? eq(agentToolCall.toolType, filters.toolType)
        : undefined,
      filters?.status !== undefined && isToolCallStatus(filters.status)
        ? eq(agentToolCall.status, filters.status)
        : undefined,
      filters?.threadId !== undefined ? eq(agentMessage.threadId, filters.threadId) : undefined,
      filters?.fromDay !== undefined
        ? gte(agentToolCall.createdAt, dayStartUtc(filters.fromDay))
        : undefined,
      filters?.toDay !== undefined
        ? lte(agentToolCall.createdAt, dayEndUtc(filters.toDay))
        : undefined,
    );
    const [totalRow] = await this.db
      .select({ value: count() })
      .from(agentToolCall)
      .innerJoin(agentMessage, eq(agentToolCall.messageId, agentMessage.id))
      .where(whereClause);
    const rows = await this.db
      .select({
        toolCallId: agentToolCall.id,
        toolName: agentToolCall.toolName,
        toolType: agentToolCall.toolType,
        status: agentToolCall.status,
        threadId: agentMessage.threadId,
        createdAt: agentToolCall.createdAt,
        runId: agentToolCall.runId,
      })
      .from(agentToolCall)
      .innerJoin(agentMessage, eq(agentToolCall.messageId, agentMessage.id))
      .where(whereClause)
      .orderBy(desc(agentToolCall.createdAt), desc(agentToolCall.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);
    return {
      rows: rows.map((row) => ({
        toolCallId: row.toolCallId,
        toolName: row.toolName,
        toolType: row.toolType,
        status: row.status,
        threadId: row.threadId,
        createdAt: row.createdAt.toISOString(),
        runId: row.runId,
      })),
      total: totalRow?.value ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * Paged, filterable thread activity, newest-first (same ordering as {@link recentThreads}).
   * `title` is a case-insensitive substring match via `lower(...)` on both sides (portable across
   * dialects, regardless of the underlying column collation). Soft-deleted threads are excluded,
   * mirroring `recentThreads`.
   */
  async threadsPage(
    query: GovernancePageQuery<ThreadWhere>,
  ): Promise<GovernancePage<ThreadActivityRow>> {
    const filters = query.where;
    const whereClause = and(
      isNull(agentThread.deletedAt),
      filters?.actorRef !== undefined ? eq(agentThread.actorRef, filters.actorRef) : undefined,
      filters?.title !== undefined
        ? like(sql`lower(${agentThread.title})`, `%${filters.title.toLowerCase()}%`)
        : undefined,
      filters?.fromDay !== undefined
        ? gte(agentThread.updatedAt, dayStartUtc(filters.fromDay))
        : undefined,
      filters?.toDay !== undefined
        ? lte(agentThread.updatedAt, dayEndUtc(filters.toDay))
        : undefined,
    );
    const [totalRow] = await this.db
      .select({ value: count() })
      .from(agentThread)
      .where(whereClause);
    const threads = await this.db
      .select()
      .from(agentThread)
      .where(whereClause)
      .orderBy(desc(agentThread.updatedAt), desc(agentThread.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);
    const rows = await this.toThreadActivityRows(threads);
    return { rows, total: totalRow?.value ?? 0, page: query.page, pageSize: query.pageSize };
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
    const whereClause = and(
      filters?.agentName !== undefined ? eq(agentRun.agentName, filters.agentName) : undefined,
      filters?.status !== undefined && isRunStatus(filters.status)
        ? eq(agentRun.status, filters.status)
        : undefined,
      filters?.errorCode !== undefined ? eq(agentRun.errorCode, filters.errorCode) : undefined,
      filters?.threadId !== undefined ? eq(agentRun.threadId, filters.threadId) : undefined,
      filters?.fromDay !== undefined
        ? gte(agentRun.startedAt, dayStartUtc(filters.fromDay))
        : undefined,
      filters?.toDay !== undefined ? lte(agentRun.startedAt, dayEndUtc(filters.toDay)) : undefined,
    );
    const [totalRow] = await this.db.select({ value: count() }).from(agentRun).where(whereClause);
    const runs = await this.db
      .select()
      .from(agentRun)
      .where(whereClause)
      .orderBy(desc(agentRun.startedAt), desc(agentRun.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);
    return {
      rows: runs.map(toRecentRunRow),
      total: totalRow?.value ?? 0,
      page: query.page,
      pageSize: query.pageSize,
    };
  }

  /**
   * Paged, filterable approvals inbox, oldest first — the same ordering as {@link pendingApprovals},
   * now with the `total` that method structurally cannot report. The join to `agent_message` /
   * `agent_thread` is unconditional (it already resolves title/actor/agentName), so the `threadId`/
   * `actorRef`/`agentName` filters cost nothing extra.
   *
   * The order is TOTAL (`created_at asc, id asc`, and `id` is the primary key), so no row can land on
   * two pages or on none for a given snapshot. Ascending order also means a newly requested approval
   * appends past the last page instead of shifting the page an operator is currently reading.
   */
  async approvalsPage(
    query: GovernancePageQuery<ApprovalWhere>,
  ): Promise<GovernancePage<PendingApprovalRow>> {
    const filters = query.where;
    const whereClause = and(
      eq(agentToolCall.status, 'pending_approval'),
      filters?.toolName !== undefined ? eq(agentToolCall.toolName, filters.toolName) : undefined,
      filters?.threadId !== undefined ? eq(agentThread.id, filters.threadId) : undefined,
      filters?.actorRef !== undefined ? eq(agentThread.actorRef, filters.actorRef) : undefined,
      filters?.agentName !== undefined ? eq(agentMessage.agentName, filters.agentName) : undefined,
      filters?.fromDay !== undefined
        ? gte(agentToolCall.createdAt, dayStartUtc(filters.fromDay))
        : undefined,
      filters?.toDay !== undefined
        ? lte(agentToolCall.createdAt, dayEndUtc(filters.toDay))
        : undefined,
    );
    const [totalRow] = await this.db
      .select({ value: count() })
      .from(agentToolCall)
      .innerJoin(agentMessage, eq(agentToolCall.messageId, agentMessage.id))
      .innerJoin(agentThread, eq(agentMessage.threadId, agentThread.id))
      .where(whereClause);
    const rows = await this.db
      .select({
        toolCallId: agentToolCall.id,
        toolName: agentToolCall.toolName,
        input: agentToolCall.input,
        threadId: agentThread.id,
        threadTitle: agentThread.title,
        actorRef: agentThread.actorRef,
        agentName: agentMessage.agentName,
        requestedAt: agentToolCall.createdAt,
        runId: agentToolCall.runId,
      })
      .from(agentToolCall)
      .innerJoin(agentMessage, eq(agentToolCall.messageId, agentMessage.id))
      .innerJoin(agentThread, eq(agentMessage.threadId, agentThread.id))
      .where(whereClause)
      .orderBy(asc(agentToolCall.createdAt), asc(agentToolCall.id))
      .limit(query.pageSize)
      .offset((query.page - 1) * query.pageSize);
    return {
      rows: rows.map((row) => ({
        toolCallId: row.toolCallId,
        toolName: row.toolName,
        input: row.input,
        threadId: row.threadId,
        threadTitle: row.threadTitle,
        actorRef: row.actorRef,
        agentName: row.agentName ?? null,
        requestedAt: row.requestedAt.toISOString(),
        runId: row.runId,
      })),
      total: totalRow?.value ?? 0,
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
    const [row] = await this.db
      .select({ run: agentRun, thread: agentThread })
      .from(agentRun)
      .innerJoin(agentThread, eq(agentRun.threadId, agentThread.id))
      .where(eq(agentRun.id, runId))
      .limit(1);
    if (row === undefined) {
      return null;
    }
    const toolCalls = await this.db
      .select()
      .from(agentToolCall)
      .where(eq(agentToolCall.runId, runId))
      .orderBy(asc(agentToolCall.createdAt), asc(agentToolCall.id));
    return {
      run: toRecentRunRow(row.run),
      thread: {
        threadId: row.thread.id,
        title: row.thread.title,
        actorRef: row.thread.actorRef,
        deleted: row.thread.deletedAt != null,
      },
      toolCalls: toolCalls.map(toRunToolCallRow),
    };
  }

  /**
   * One thread with its lifetime usage rollup, its newest runs and its newest messages. A fixed six
   * queries (thread, usage, message count, message page, that page's tool-call counts, runs+count) —
   * the per-message tool-call counts are ONE grouped read over the returned message ids, not one per
   * message. Soft-deleted threads are returned with `deleted: true`; an audit still needs them.
   */
  async threadDetail(query: GovernanceThreadDetailQuery): Promise<GovernanceThreadDetail | null> {
    const [thread] = await this.db
      .select()
      .from(agentThread)
      .where(eq(agentThread.id, query.threadId))
      .limit(1);
    if (thread === undefined) {
      return null;
    }
    const pricing = await this.loadPricing();
    const usageRows = await this.db
      .select()
      .from(agentTokenUsage)
      .where(eq(agentTokenUsage.threadId, thread.id));
    const usage = rollupThreadUsage(usageRows.map(toUsageInput), pricing);
    const [messageCountRow] = await this.db
      .select({ value: count() })
      .from(agentMessage)
      .where(eq(agentMessage.threadId, thread.id));
    const messages = await this.db
      .select()
      .from(agentMessage)
      .where(eq(agentMessage.threadId, thread.id))
      .orderBy(desc(agentMessage.createdAt), desc(agentMessage.id))
      .limit(query.messageLimit);
    const toolCallCounts = await this.toolCallCountsByMessage(
      messages.map((message) => message.id),
    );
    const [runTotalRow] = await this.db
      .select({ value: count() })
      .from(agentRun)
      .where(eq(agentRun.threadId, thread.id));
    const runs = await this.db
      .select()
      .from(agentRun)
      .where(eq(agentRun.threadId, thread.id))
      .orderBy(desc(agentRun.startedAt), desc(agentRun.id))
      .limit(query.runLimit);
    return {
      thread: {
        threadId: thread.id,
        title: thread.title,
        actorRef: thread.actorRef,
        messageCount: messageCountRow?.value ?? 0,
        totalTokens: usage.totalTokens,
        lastActivityAt: thread.updatedAt.toISOString(),
      },
      deleted: thread.deletedAt != null,
      usage,
      runs: runs.map(toRecentRunRow),
      runTotal: runTotalRow?.value ?? 0,
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

  /** Tool-call counts for a set of messages in ONE grouped query — the detail view's no-N+1 guarantee. */
  private async toolCallCountsByMessage(messageIds: string[]): Promise<Map<string, number>> {
    const counts = new Map<string, number>();
    if (messageIds.length === 0) {
      return counts;
    }
    const rows = await this.db
      .select({ messageId: agentToolCall.messageId, value: count() })
      .from(agentToolCall)
      .where(inArray(agentToolCall.messageId, messageIds))
      .groupBy(agentToolCall.messageId);
    for (const row of rows) {
      counts.set(row.messageId, row.value);
    }
    return counts;
  }
}
