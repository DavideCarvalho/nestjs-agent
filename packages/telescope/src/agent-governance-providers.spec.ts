import type {
  ActorSpendRow,
  AgentGovernanceQueries,
  GovernanceRange,
  ModelSpendRow,
  PendingApprovalRow,
  RecentRunRow,
  RunAgentBreakdownRow,
  RunErrorBreakdownRow,
  RunMetrics,
  RunTrendPoint,
  ThreadActivityRow,
  ThreadSpendRow,
  ToolCallActivityRow,
  ToolStatRow,
  UsageTrendPoint,
} from '@dudousxd/nestjs-agent-core';
import { AGENT_GOVERNANCE_QUERIES } from '@dudousxd/nestjs-agent-core';
import type { ExtensionContext } from '@dudousxd/nestjs-telescope';
import { describe, expect, it } from 'vitest';
import {
  agentActorSpendTableProvider,
  agentModelSpendTableProvider,
  agentPendingApprovalsCountProvider,
  agentPendingApprovalsTableProvider,
  agentRecentRunsTableProvider,
  agentRecentThreadsTableProvider,
  agentRecentToolCallsTableProvider,
  agentRunErrorsProvider,
  agentRunsByAgentTableProvider,
  agentRunsDurationProvider,
  agentRunsFailedProvider,
  agentRunsRetriesProvider,
  agentRunsSuccessRateProvider,
  agentRunsTotalProvider,
  agentRunsTrendProvider,
  agentSpendByModelProvider,
  agentSpendTotalProvider,
  agentTokensTotalProvider,
  agentToolStatsTableProvider,
  agentTopThreadsTableProvider,
  agentUsageTrendProvider,
  capErrorMessage,
  resolveRange,
  shiftUtcDay,
  shortPromptHash,
  toActorSpendRows,
  toActorSpendSegments,
  toModelSpendRows,
  toModelSpendSegments,
  toRecentRunTableRows,
  toRunAgentTableRows,
  toRunErrorSegments,
  toRunTrendRows,
  toThreadSpendRows,
  toToolStatTableRows,
  toUsageTrendRows,
  totalCostUsd,
  totalTokens,
} from './agent-governance-providers.js';

const MODEL_ROWS: ModelSpendRow[] = [
  { modelId: 'gpt-4o', requests: 10, inputTokens: 1_000, outputTokens: 500, costUsd: 1.2345 },
  { modelId: 'unpriced', requests: 4, inputTokens: 200, outputTokens: 100, costUsd: 0 },
];

const ACTOR_ROWS: ActorSpendRow[] = [
  { actorRef: 'user:1', requests: 6, totalTokens: 1_200, costUsd: 0.9876, threadCount: 3 },
  { actorRef: 'user:2', requests: 2, totalTokens: 300, costUsd: 0, threadCount: 1 },
];

const TREND_POINTS: UsageTrendPoint[] = [
  { day: '2026-07-01', totalTokens: 1_500, costUsd: 1.239 },
  { day: '2026-07-02', totalTokens: 300, costUsd: 0.004 },
];

const THREAD_ROWS: ThreadSpendRow[] = [
  {
    threadId: 'th1',
    title: 'Incident triage',
    actorRef: 'user:1',
    requests: 6,
    totalTokens: 1_200,
    costUsd: 0.9876,
  },
  { threadId: 'th2', title: '', actorRef: 'user:2', requests: 2, totalTokens: 300, costUsd: 0 },
];

const RUN_METRICS: RunMetrics = {
  runs: 12,
  completed: 9,
  failed: 3,
  successRate: 0.75,
  retries: 4,
  durationP50Ms: 820,
  durationP95Ms: 4_100,
};

const RUN_AGENT_ROWS: RunAgentBreakdownRow[] = [
  { agentName: 'triage', runs: 8, failed: 1, retries: 2 },
  { agentName: '(default)', runs: 4, failed: 2, retries: 2 },
];

const RUN_ERROR_ROWS: RunErrorBreakdownRow[] = [
  { errorCode: 'quota_exceeded', count: 2 },
  { errorCode: 'unknown', count: 1 },
];

const RUN_TREND_POINTS: RunTrendPoint[] = [
  { day: '2026-07-01', runs: 5, failed: 1 },
  { day: '2026-07-02', runs: 7, failed: 2 },
];

const LONG_ERROR_MESSAGE = `boom ${'x'.repeat(600)}`;

const RECENT_RUN_ROWS: RecentRunRow[] = [
  {
    runId: 'run1',
    threadId: 'th1',
    actorRef: 'user:1',
    agentName: 'triage',
    status: 'failed',
    durationMs: 1_500,
    errorCode: 'quota_exceeded',
    errorMessage: LONG_ERROR_MESSAGE,
    retries: 1,
    startedAt: '2026-07-01T00:00:00.000Z',
    promptHash: 'abcdef0123456789',
  },
  {
    runId: 'run2',
    threadId: 'th2',
    actorRef: 'user:2',
    agentName: null,
    status: 'completed',
    durationMs: null,
    errorCode: null,
    errorMessage: null,
    retries: 0,
    startedAt: '2026-07-02T00:00:00.000Z',
    promptHash: null,
  },
];

const TOOL_CALL_ROWS: ToolCallActivityRow[] = [
  {
    toolCallId: 'tc1',
    toolName: 'search',
    toolType: 'read',
    status: 'executed',
    threadId: 'th1',
    createdAt: '2026-07-01T00:00:00.000Z',
  },
];

const THREAD_ACTIVITY_ROWS: ThreadActivityRow[] = [
  {
    threadId: 'th1',
    title: 'Incident triage',
    actorRef: 'user:1',
    messageCount: 5,
    totalTokens: 1_200,
    lastActivityAt: '2026-07-01T00:00:00.000Z',
  },
];

const PENDING_APPROVAL_ROWS: PendingApprovalRow[] = [
  {
    toolCallId: 'tc2',
    toolName: 'send_email',
    input: { to: 'a@b.com' },
    threadId: 'th1',
    threadTitle: 'Incident triage',
    actorRef: 'user:1',
    agentName: null,
    requestedAt: '2026-07-01T00:00:00.000Z',
  },
];

const TOOL_STAT_ROWS: ToolStatRow[] = [
  { toolName: 'search', toolType: 'read', calls: 10, failed: 1, rejected: 0, p95ExecutionMs: 250 },
  {
    toolName: 'send_email',
    toolType: 'action',
    calls: 3,
    failed: 0,
    rejected: 1,
    p95ExecutionMs: null,
  },
];

/** A fully-implementing stub of the read-model; each method ignores its range and echoes fixtures. */
function stubQueries(): AgentGovernanceQueries {
  return {
    async spendByModel(_range: GovernanceRange) {
      return MODEL_ROWS;
    },
    async spendByActor(_range: GovernanceRange) {
      return ACTOR_ROWS;
    },
    async spendByThread(_range: GovernanceRange, _limit: number) {
      return THREAD_ROWS;
    },
    async usageTrend(_range: GovernanceRange) {
      return TREND_POINTS;
    },
    async recentToolCalls(_limit: number) {
      return TOOL_CALL_ROWS;
    },
    async recentThreads(_limit: number) {
      return THREAD_ACTIVITY_ROWS;
    },
    async runMetrics(_range: GovernanceRange) {
      return RUN_METRICS;
    },
    async runsByAgent(_range: GovernanceRange) {
      return RUN_AGENT_ROWS;
    },
    async runErrors(_range: GovernanceRange) {
      return RUN_ERROR_ROWS;
    },
    async runTrend(_range: GovernanceRange) {
      return RUN_TREND_POINTS;
    },
    async recentRuns(_limit: number) {
      return RECENT_RUN_ROWS;
    },
    async pendingApprovals(_limit: number) {
      return PENDING_APPROVAL_ROWS;
    },
    async toolStats(_range: GovernanceRange) {
      return TOOL_STAT_ROWS;
    },
  };
}

const MISSING_BINDING = Symbol('missing');

/**
 * Build a minimal `ExtensionContext` whose `moduleRef.get` returns the supplied binding (or throws,
 * like Nest does for an unregistered token, when `MISSING_BINDING` is passed). Cast once at the test
 * boundary — the providers only ever touch `ctx.moduleRef.get`.
 */
function contextWith(binding: AgentGovernanceQueries | typeof MISSING_BINDING): ExtensionContext {
  const moduleRef = {
    get(token: symbol): unknown {
      if (token !== AGENT_GOVERNANCE_QUERIES || binding === MISSING_BINDING) {
        throw new Error('UnknownElementException');
      }
      return binding;
    },
  };
  return { moduleRef, config: {} } as unknown as ExtensionContext;
}

describe('governance data-shaping', () => {
  it('sums authoritative cost across model rows, rounded to cents', () => {
    expect(totalCostUsd(MODEL_ROWS)).toBe(1.23);
  });

  it('sums input + output tokens across model rows', () => {
    expect(totalTokens(MODEL_ROWS)).toBe(1_800);
  });

  it('drops zero-cost models from the spend donut', () => {
    expect(toModelSpendSegments(MODEL_ROWS)).toEqual([{ label: 'gpt-4o', value: 1.23 }]);
  });

  it('keeps every model (incl. unpriced) in the table with usage intact', () => {
    expect(toModelSpendRows(MODEL_ROWS)).toEqual([
      { modelId: 'gpt-4o', requests: 10, inputTokens: 1_000, outputTokens: 500, costUsd: 1.23 },
      { modelId: 'unpriced', requests: 4, inputTokens: 200, outputTokens: 100, costUsd: 0 },
    ]);
  });

  it('shapes actor spend rows and drops zero-cost actors from the share', () => {
    expect(toActorSpendRows(ACTOR_ROWS)).toEqual([
      { actorRef: 'user:1', requests: 6, totalTokens: 1_200, costUsd: 0.99 },
      { actorRef: 'user:2', requests: 2, totalTokens: 300, costUsd: 0 },
    ]);
    expect(toActorSpendSegments(ACTOR_ROWS)).toEqual([{ label: 'user:1', value: 0.99 }]);
  });

  it('shapes thread spend rows, falling back to threadId when title is blank', () => {
    expect(toThreadSpendRows(THREAD_ROWS)).toEqual([
      {
        title: 'Incident triage',
        actorRef: 'user:1',
        requests: 6,
        totalTokens: 1_200,
        costUsd: 0.99,
      },
      { title: 'th2', actorRef: 'user:2', requests: 2, totalTokens: 300, costUsd: 0 },
    ]);
  });

  it('maps the usage trend to label-keyed timeseries rows', () => {
    expect(toUsageTrendRows(TREND_POINTS)).toEqual([
      { label: '2026-07-01', costUsd: 1.24, totalTokens: 1_500 },
      { label: '2026-07-02', costUsd: 0, totalTokens: 300 },
    ]);
  });
});

describe('resolveRange', () => {
  it('honours explicit ISO from/to days', () => {
    expect(resolveRange({ fromDay: '2026-06-01', toDay: '2026-06-30' })).toEqual({
      fromDay: '2026-06-01',
      toDay: '2026-06-30',
    });
  });

  it('ignores malformed range fields and falls back to the trailing window', () => {
    const range = resolveRange({ fromDay: 'not-a-day', toDay: 42 });
    expect(range.toDay).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(shiftUtcDay(range.fromDay, 29)).toBe(range.toDay);
  });

  it('defaults to a 30-day inclusive window when no query is given', () => {
    const range = resolveRange(undefined);
    expect(shiftUtcDay(range.fromDay, 29)).toBe(range.toDay);
  });
});

describe('shiftUtcDay', () => {
  it('crosses month boundaries in UTC', () => {
    expect(shiftUtcDay('2026-03-01', -1)).toBe('2026-02-28');
    expect(shiftUtcDay('2026-02-28', 1)).toBe('2026-03-01');
  });
});

describe('governance providers', () => {
  it('resolve authoritative totals from the injected read-model', async () => {
    const ctx = contextWith(stubQueries());
    await expect(agentSpendTotalProvider().resolve({}, ctx)).resolves.toEqual({ value: 1.23 });
    await expect(agentTokensTotalProvider().resolve({}, ctx)).resolves.toEqual({ value: 1_800 });
    await expect(agentSpendByModelProvider().resolve({}, ctx)).resolves.toEqual({
      segments: [{ label: 'gpt-4o', value: 1.23 }],
    });
    await expect(agentModelSpendTableProvider().resolve({}, ctx)).resolves.toEqual({
      rows: toModelSpendRows(MODEL_ROWS),
    });
    await expect(agentUsageTrendProvider().resolve({}, ctx)).resolves.toEqual({
      rows: toUsageTrendRows(TREND_POINTS),
    });
    await expect(agentActorSpendTableProvider().resolve({}, ctx)).resolves.toEqual({
      rows: toActorSpendRows(ACTOR_ROWS),
    });
    await expect(agentTopThreadsTableProvider().resolve({}, ctx)).resolves.toEqual({
      rows: toThreadSpendRows(THREAD_ROWS),
    });
  });

  it('degrade to empty-but-valid shapes when the host has not bound the read-model', async () => {
    const ctx = contextWith(MISSING_BINDING);
    await expect(agentSpendTotalProvider().resolve({}, ctx)).resolves.toEqual({ value: 0 });
    await expect(agentTokensTotalProvider().resolve({}, ctx)).resolves.toEqual({ value: 0 });
    await expect(agentSpendByModelProvider().resolve({}, ctx)).resolves.toEqual({ segments: [] });
    await expect(agentModelSpendTableProvider().resolve({}, ctx)).resolves.toEqual({ rows: [] });
    await expect(agentUsageTrendProvider().resolve({}, ctx)).resolves.toEqual({ rows: [] });
    await expect(agentActorSpendTableProvider().resolve({}, ctx)).resolves.toEqual({ rows: [] });
    await expect(agentTopThreadsTableProvider().resolve({}, ctx)).resolves.toEqual({ rows: [] });
  });
});

describe('reliability data-shaping', () => {
  it('passes run/agent breakdown rows through as table rows', () => {
    expect(toRunAgentTableRows(RUN_AGENT_ROWS)).toEqual(RUN_AGENT_ROWS);
  });

  it('shapes run errors as breakdown segments', () => {
    expect(toRunErrorSegments(RUN_ERROR_ROWS)).toEqual([
      { label: 'quota_exceeded', value: 2 },
      { label: 'unknown', value: 1 },
    ]);
  });

  it('maps the run trend to label-keyed timeseries rows', () => {
    expect(toRunTrendRows(RUN_TREND_POINTS)).toEqual([
      { label: '2026-07-01', runs: 5, failed: 1 },
      { label: '2026-07-02', runs: 7, failed: 2 },
    ]);
  });

  it('caps a long error message at 500 chars with an ellipsis', () => {
    const capped = capErrorMessage(LONG_ERROR_MESSAGE);
    expect(capped).not.toBeNull();
    expect(capped?.length).toBe(501); // 500 chars + the ellipsis marker
    expect(capped?.endsWith('…')).toBe(true);
  });

  it('leaves a short error message untouched', () => {
    expect(capErrorMessage('boom')).toBe('boom');
  });

  it('passes null through capErrorMessage', () => {
    expect(capErrorMessage(null)).toBeNull();
  });

  it('shortens a promptHash to a chip', () => {
    expect(shortPromptHash('abcdef0123456789')).toBe('abcdef0123');
    expect(shortPromptHash(null)).toBeNull();
  });

  it('shapes recent runs: errorMessage capped, promptHash shortened, nulls fall back to —', () => {
    const rows = toRecentRunTableRows(RECENT_RUN_ROWS);
    expect(rows[0]).toEqual({
      startedAt: '2026-07-01T00:00:00.000Z',
      runId: 'run1',
      threadId: 'th1',
      actorRef: 'user:1',
      agentName: 'triage',
      status: 'failed',
      durationMs: 1_500,
      retries: 1,
      errorCode: 'quota_exceeded',
      errorMessage: capErrorMessage(LONG_ERROR_MESSAGE),
      promptHash: 'abcdef0123',
    });
    expect(rows[1]).toEqual({
      startedAt: '2026-07-02T00:00:00.000Z',
      runId: 'run2',
      threadId: 'th2',
      actorRef: 'user:2',
      agentName: '—',
      status: 'completed',
      durationMs: '—',
      retries: 0,
      errorCode: '—',
      errorMessage: '—',
      promptHash: '—',
    });
  });

  it('falls back p95ExecutionMs to — when unmeasured', () => {
    expect(toToolStatTableRows(TOOL_STAT_ROWS)).toEqual([
      {
        toolName: 'search',
        toolType: 'read',
        calls: 10,
        failed: 1,
        rejected: 0,
        p95ExecutionMs: 250,
      },
      {
        toolName: 'send_email',
        toolType: 'action',
        calls: 3,
        failed: 0,
        rejected: 1,
        p95ExecutionMs: '—',
      },
    ]);
  });
});

describe('reliability + tools + approvals providers', () => {
  it('resolve from the injected read-model', async () => {
    const ctx = contextWith(stubQueries());
    await expect(agentRunsTotalProvider().resolve({}, ctx)).resolves.toEqual({ value: 12 });
    await expect(agentRunsSuccessRateProvider().resolve({}, ctx)).resolves.toEqual({ value: 0.75 });
    await expect(agentRunsFailedProvider().resolve({}, ctx)).resolves.toEqual({ value: 3 });
    await expect(agentRunsRetriesProvider().resolve({}, ctx)).resolves.toEqual({ value: 4 });
    await expect(agentRunsDurationProvider().resolve({}, ctx)).resolves.toEqual({
      buckets: [],
      p50: 820,
      p95: 4_100,
    });
    await expect(agentRunsByAgentTableProvider().resolve({}, ctx)).resolves.toEqual({
      rows: RUN_AGENT_ROWS,
    });
    await expect(agentRunErrorsProvider().resolve({}, ctx)).resolves.toEqual({
      segments: toRunErrorSegments(RUN_ERROR_ROWS),
    });
    await expect(agentRunsTrendProvider().resolve({}, ctx)).resolves.toEqual({
      rows: toRunTrendRows(RUN_TREND_POINTS),
    });
    await expect(agentRecentRunsTableProvider().resolve({}, ctx)).resolves.toEqual({
      rows: toRecentRunTableRows(RECENT_RUN_ROWS),
    });
    await expect(agentRecentToolCallsTableProvider().resolve({}, ctx)).resolves.toEqual({
      rows: TOOL_CALL_ROWS,
    });
    await expect(agentRecentThreadsTableProvider().resolve({}, ctx)).resolves.toEqual({
      rows: THREAD_ACTIVITY_ROWS,
    });
    await expect(agentPendingApprovalsCountProvider().resolve({}, ctx)).resolves.toEqual({
      value: 1,
    });
    await expect(agentPendingApprovalsTableProvider().resolve({}, ctx)).resolves.toEqual({
      rows: [
        {
          toolCallId: 'tc2',
          toolName: 'send_email',
          threadId: 'th1',
          threadTitle: 'Incident triage',
          actorRef: 'user:1',
          agentName: '—',
          requestedAt: '2026-07-01T00:00:00.000Z',
        },
      ],
    });
    await expect(agentToolStatsTableProvider().resolve({}, ctx)).resolves.toEqual({
      rows: toToolStatTableRows(TOOL_STAT_ROWS),
    });
  });

  it('degrade to empty-but-valid shapes when the host has not bound the read-model', async () => {
    const ctx = contextWith(MISSING_BINDING);
    await expect(agentRunsTotalProvider().resolve({}, ctx)).resolves.toEqual({ value: 0 });
    await expect(agentRunsSuccessRateProvider().resolve({}, ctx)).resolves.toEqual({ value: 0 });
    await expect(agentRunsFailedProvider().resolve({}, ctx)).resolves.toEqual({ value: 0 });
    await expect(agentRunsRetriesProvider().resolve({}, ctx)).resolves.toEqual({ value: 0 });
    await expect(agentRunsDurationProvider().resolve({}, ctx)).resolves.toEqual({ buckets: [] });
    await expect(agentRunsByAgentTableProvider().resolve({}, ctx)).resolves.toEqual({ rows: [] });
    await expect(agentRunErrorsProvider().resolve({}, ctx)).resolves.toEqual({ segments: [] });
    await expect(agentRunsTrendProvider().resolve({}, ctx)).resolves.toEqual({ rows: [] });
    await expect(agentRecentRunsTableProvider().resolve({}, ctx)).resolves.toEqual({ rows: [] });
    await expect(agentRecentToolCallsTableProvider().resolve({}, ctx)).resolves.toEqual({
      rows: [],
    });
    await expect(agentRecentThreadsTableProvider().resolve({}, ctx)).resolves.toEqual({ rows: [] });
    await expect(agentPendingApprovalsCountProvider().resolve({}, ctx)).resolves.toEqual({
      value: 0,
    });
    await expect(agentPendingApprovalsTableProvider().resolve({}, ctx)).resolves.toEqual({
      rows: [],
    });
    await expect(agentToolStatsTableProvider().resolve({}, ctx)).resolves.toEqual({ rows: [] });
  });

  it('clamps a limit-scoped query above the hard ceiling (still resolves the fixture rows)', async () => {
    const ctx = contextWith(stubQueries());
    await expect(agentRecentRunsTableProvider().resolve({ limit: 10_000 }, ctx)).resolves.toEqual({
      rows: toRecentRunTableRows(RECENT_RUN_ROWS),
    });
  });
});
