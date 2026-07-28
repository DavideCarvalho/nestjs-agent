import type {
  ActorResolver,
  ActorSpendRow,
  AgentApprovalPort,
  AgentGovernanceQueries,
  AgentPricingStore,
  CurrentModelPrice,
  GovernancePage,
  GovernanceRange,
  ModelPriceInput,
  ModelSpendRow,
  PendingApprovalRow,
  RecentRunRow,
  RunAgentBreakdownRow,
  RunErrorBreakdownRow,
  RunMetrics,
  RunTrendPoint,
  RunWhere,
  ThreadActivityRow,
  ThreadSpendRow,
  ThreadWhere,
  ToolCallActivityRow,
  ToolCallWhere,
  ToolStatRow,
  UsageTrendPoint,
} from '@dudousxd/nestjs-agent-core';
import { publishAgentToolCall } from '@dudousxd/nestjs-agent-core';
import { NotImplementedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { ActorDirectory } from './actor-directory.js';
import { AgentApiController } from './agent-api.controller.js';
import { DashboardService, type LiveAgentEvent } from './dashboard.service.js';

/** A zeroed `RunMetrics` — the shape a store without run recording returns. */
const EMPTY_RUN_METRICS: RunMetrics = {
  runs: 0,
  completed: 0,
  failed: 0,
  successRate: 0,
  retries: 0,
  durationP50Ms: null,
  durationP95Ms: null,
};

interface QueriesOverrides {
  record?: (call: string) => void;
  spendByModel?: ModelSpendRow[];
  spendByActor?: ActorSpendRow[];
  spendByThread?: ThreadSpendRow[];
  usageTrend?: UsageTrendPoint[];
  recentToolCalls?: ToolCallActivityRow[];
  recentThreads?: ThreadActivityRow[];
  runMetrics?: RunMetrics;
  runsByAgent?: RunAgentBreakdownRow[];
  runErrors?: RunErrorBreakdownRow[];
  runTrend?: RunTrendPoint[];
  recentRuns?: RecentRunRow[];
  pendingApprovals?: PendingApprovalRow[];
  toolStats?: ToolStatRow[];
  toolCallsPage?: GovernancePage<ToolCallActivityRow>;
  threadsPage?: GovernancePage<ThreadActivityRow>;
  runsPage?: GovernancePage<RecentRunRow>;
}

/** An empty `GovernancePage` — the shape a store without the backing data returns. */
function emptyPage<TRow>(page: number, pageSize: number): GovernancePage<TRow> {
  return { rows: [], total: 0, page, pageSize };
}

/** A `AgentGovernanceQueries` fake — records each call and returns the override (or `[]`). */
function fakeQueries(overrides: QueriesOverrides = {}): AgentGovernanceQueries {
  const record = overrides.record ?? (() => {});
  return {
    async spendByModel(_range: GovernanceRange) {
      record('spendByModel');
      return overrides.spendByModel ?? [];
    },
    async spendByActor(_range: GovernanceRange) {
      record('spendByActor');
      return overrides.spendByActor ?? [];
    },
    async spendByThread(_range: GovernanceRange, _limit: number) {
      record('spendByThread');
      return overrides.spendByThread ?? [];
    },
    async usageTrend(_range: GovernanceRange) {
      record('usageTrend');
      return overrides.usageTrend ?? [];
    },
    async recentToolCalls(_limit: number) {
      record('recentToolCalls');
      return overrides.recentToolCalls ?? [];
    },
    async recentThreads(_limit: number) {
      record('recentThreads');
      return overrides.recentThreads ?? [];
    },
    async runMetrics(_range: GovernanceRange) {
      record('runMetrics');
      return overrides.runMetrics ?? EMPTY_RUN_METRICS;
    },
    async runsByAgent(_range: GovernanceRange) {
      record('runsByAgent');
      return overrides.runsByAgent ?? [];
    },
    async runErrors(_range: GovernanceRange) {
      record('runErrors');
      return overrides.runErrors ?? [];
    },
    async runTrend(_range: GovernanceRange) {
      record('runTrend');
      return overrides.runTrend ?? [];
    },
    async recentRuns(_limit: number) {
      record('recentRuns');
      return overrides.recentRuns ?? [];
    },
    async pendingApprovals(_limit: number) {
      record('pendingApprovals');
      return overrides.pendingApprovals ?? [];
    },
    async toolStats(_range: GovernanceRange) {
      record('toolStats');
      return overrides.toolStats ?? [];
    },
    async toolCallsPage(query: { page: number; pageSize: number; where?: ToolCallWhere }) {
      record('toolCallsPage');
      return overrides.toolCallsPage ?? emptyPage(query.page, query.pageSize);
    },
    async threadsPage(query: { page: number; pageSize: number; where?: ThreadWhere }) {
      record('threadsPage');
      return overrides.threadsPage ?? emptyPage(query.page, query.pageSize);
    },
    async runsPage(query: { page: number; pageSize: number; where?: RunWhere }) {
      record('runsPage');
      return overrides.runsPage ?? emptyPage(query.page, query.pageSize);
    },
  };
}

/** An `AgentApprovalPort` fake — records each call it saw. */
function fakeApprovalPort(
  calls: { method: 'approve' | 'reject'; toolCallId: string; opts?: unknown }[] = [],
): AgentApprovalPort {
  return {
    async approve(toolCallId, opts) {
      calls.push({ method: 'approve', toolCallId, opts });
    },
    async reject(toolCallId, opts) {
      calls.push({ method: 'reject', toolCallId, opts });
    },
  };
}

describe('DashboardService', () => {
  it('spend() fans the three read-model queries and shapes the overview', async () => {
    const calls: string[] = [];
    const service = new DashboardService(
      fakeQueries({
        record: (call) => calls.push(call),
        spendByModel: [
          { modelId: 'gpt', requests: 2, inputTokens: 10, outputTokens: 5, costUsd: 0.4 },
        ],
        spendByActor: [
          { actorRef: 'user:1', requests: 2, totalTokens: 15, costUsd: 0.4, threadCount: 1 },
        ],
        usageTrend: [{ day: '2026-07-01', totalTokens: 15, costUsd: 0.4 }],
      }),
    );

    const overview = await service.spend({ fromDay: '2026-07-01', toDay: '2026-07-05' });

    expect(calls.sort()).toEqual(['spendByActor', 'spendByModel', 'usageTrend']);
    expect(overview.byModel[0]?.modelId).toBe('gpt');
    expect(overview.byActor[0]?.actorRef).toBe('user:1');
    expect(overview.trend[0]?.day).toBe('2026-07-01');
  });

  it('reliability() fans the four run-reliability queries and shapes the overview', async () => {
    const calls: string[] = [];
    const runMetrics: RunMetrics = {
      runs: 10,
      completed: 8,
      failed: 2,
      successRate: 0.8,
      retries: 3,
      durationP50Ms: 420,
      durationP95Ms: 1800,
    };
    const service = new DashboardService(
      fakeQueries({
        record: (call) => calls.push(call),
        runMetrics,
        runsByAgent: [{ agentName: 'analyst', runs: 6, failed: 1, retries: 2 }],
        runErrors: [{ errorCode: 'TIMEOUT', count: 2 }],
        runTrend: [{ day: '2026-07-01', runs: 4, failed: 1 }],
      }),
    );

    const overview = await service.reliability({ fromDay: '2026-07-01', toDay: '2026-07-05' });

    expect(calls.sort()).toEqual(['runErrors', 'runMetrics', 'runTrend', 'runsByAgent']);
    expect(overview.metrics).toEqual(runMetrics);
    expect(overview.byAgent[0]?.agentName).toBe('analyst');
    expect(overview.errors[0]?.errorCode).toBe('TIMEOUT');
    expect(overview.trend[0]?.day).toBe('2026-07-01');
  });

  it('recentRuns() passes through to the read-model', async () => {
    const service = new DashboardService(
      fakeQueries({
        recentRuns: [
          {
            runId: 'r1',
            threadId: 'th1',
            actorRef: 'user:1',
            agentName: 'analyst',
            status: 'failed',
            durationMs: 1200,
            errorCode: 'TIMEOUT',
            errorMessage: 'upstream timed out',
            retries: 1,
            startedAt: '2026-07-05T00:00:00.000Z',
            promptHash: null,
          },
        ],
      }),
    );

    expect((await service.recentRuns(10))[0]?.runId).toBe('r1');
  });

  it('recentToolCalls / recentThreads pass through to the read-model', async () => {
    const service = new DashboardService(
      fakeQueries({
        recentToolCalls: [
          {
            toolCallId: 't1',
            toolName: 'search',
            toolType: 'read',
            status: 'ok',
            threadId: 'th1',
            createdAt: '2026-07-05T00:00:00.000Z',
            runId: 'r1',
          },
        ],
        recentThreads: [
          {
            threadId: 'th1',
            title: 'hello',
            actorRef: 'user:1',
            messageCount: 4,
            totalTokens: 20,
            lastActivityAt: '2026-07-05T00:00:00.000Z',
          },
        ],
      }),
    );

    expect((await service.recentToolCalls(10))[0]?.toolName).toBe('search');
    expect((await service.recentThreads(10))[0]?.threadId).toBe('th1');
  });

  it('pendingApprovals() passes through to the read-model', async () => {
    const service = new DashboardService(
      fakeQueries({
        pendingApprovals: [
          {
            toolCallId: 'tc1',
            toolName: 'purgeCache',
            input: { key: 'cfg' },
            threadId: 'th1',
            threadTitle: 'hi',
            actorRef: 'user:1',
            agentName: 'analyst',
            requestedAt: '2026-07-05T00:00:00.000Z',
            runId: 'r1',
          },
        ],
      }),
    );

    expect((await service.pendingApprovals(10))[0]?.toolCallId).toBe('tc1');
  });

  it('toolStats() passes the range through to the read-model', async () => {
    const service = new DashboardService(
      fakeQueries({
        toolStats: [
          {
            toolName: 'purgeCache',
            toolType: 'action',
            calls: 4,
            failed: 1,
            rejected: 1,
            p95ExecutionMs: 320,
          },
        ],
      }),
    );

    const rows = await service.toolStats({ fromDay: '2026-07-01', toDay: '2026-07-05' });
    expect(rows[0]?.toolName).toBe('purgeCache');
  });

  it('topThreads() passes the range and limit through to the read-model', async () => {
    const service = new DashboardService(
      fakeQueries({
        spendByThread: [
          {
            threadId: 'th1',
            title: 'hello',
            actorRef: 'user:1',
            requests: 3,
            totalTokens: 30,
            costUsd: 0.5,
          },
        ],
      }),
    );

    const rows = await service.topThreads({ fromDay: '2026-07-01', toDay: '2026-07-05' }, 5);

    expect(rows[0]?.threadId).toBe('th1');
    expect(rows[0]?.costUsd).toBe(0.5);
  });

  it('toolCallsPage() passes the query through to the read-model', async () => {
    const calls: string[] = [];
    const page: GovernancePage<ToolCallActivityRow> = {
      rows: [
        {
          toolCallId: 't1',
          toolName: 'search',
          toolType: 'read',
          status: 'ok',
          threadId: 'th1',
          createdAt: '2026-07-05T00:00:00.000Z',
          runId: 'r1',
        },
      ],
      total: 40,
      page: 2,
      pageSize: 25,
    };
    const service = new DashboardService(
      fakeQueries({ record: (call) => calls.push(call), toolCallsPage: page }),
    );

    const result = await service.toolCallsPage({
      page: 2,
      pageSize: 25,
      where: { toolName: 'search' },
    });

    expect(calls).toEqual(['toolCallsPage']);
    expect(result).toEqual(page);
  });

  it('runsPage() passes the query through to the read-model', async () => {
    const calls: string[] = [];
    const page: GovernancePage<RecentRunRow> = {
      rows: [
        {
          runId: 'r1',
          threadId: 'th1',
          actorRef: 'user:1',
          agentName: 'analyst',
          status: 'failed',
          durationMs: 1200,
          errorCode: 'TIMEOUT',
          errorMessage: 'upstream timed out',
          retries: 1,
          startedAt: '2026-07-05T00:00:00.000Z',
          promptHash: null,
        },
      ],
      total: 3,
      page: 1,
      pageSize: 25,
    };
    const service = new DashboardService(
      fakeQueries({ record: (call) => calls.push(call), runsPage: page }),
    );

    const result = await service.runsPage({ page: 1, pageSize: 25, where: { status: 'failed' } });

    expect(calls).toEqual(['runsPage']);
    expect(result).toEqual(page);
  });

  it('threadsPage() decorates rows with actorLabel, batching the distinct refs, and preserves paging', async () => {
    const seenRefs: string[][] = [];
    const page: GovernancePage<ThreadActivityRow> = {
      rows: [
        {
          threadId: 'th1',
          title: 'hello',
          actorRef: 'user:1',
          messageCount: 4,
          totalTokens: 20,
          lastActivityAt: '2026-07-05T00:00:00.000Z',
        },
      ],
      total: 12,
      page: 1,
      pageSize: 25,
    };
    const service = new DashboardService(
      fakeQueries({ threadsPage: page }),
      fakeActorDirectory({ 'user:1': 'Ada Lovelace' }, seenRefs),
    );

    const result = await service.threadsPage({ page: 1, pageSize: 25, where: { title: 'hel' } });

    expect(result.total).toBe(12);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(25);
    expect(result.rows[0]?.actorLabel).toBe('Ada Lovelace');
    expect(seenRefs).toEqual([['user:1']]);
  });

  it('threadsPage() leaves actorLabel null on every row when no ActorDirectory is bound', async () => {
    const service = new DashboardService(
      fakeQueries({
        threadsPage: {
          rows: [
            {
              threadId: 'th1',
              title: 'hello',
              actorRef: 'user:1',
              messageCount: 4,
              totalTokens: 20,
              lastActivityAt: '2026-07-05T00:00:00.000Z',
            },
          ],
          total: 1,
          page: 1,
          pageSize: 25,
        },
      }),
    );

    const result = await service.threadsPage({ page: 1, pageSize: 25 });

    expect(result.rows[0]?.actorLabel).toBeNull();
  });

  it('streamEvents() forwards a live agent diagnostics event to a subscriber', async () => {
    const service = new DashboardService(fakeQueries());
    const seen: LiveAgentEvent[] = [];
    const subscription = service
      .streamEvents()
      .subscribe((message: { data: LiveAgentEvent }) => seen.push(message.data));

    publishAgentToolCall({ runId: 'r1', toolName: 'search', toolType: 'read', status: 'ok' });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.event).toBe('tool-call');
    expect(seen[0]?.payload.toolName).toBe('search');

    subscription.unsubscribe();
  });

  it('streamEvents() stops forwarding after unsubscribe', () => {
    const service = new DashboardService(fakeQueries());
    const seen: LiveAgentEvent[] = [];
    const subscription = service
      .streamEvents()
      .subscribe((message: { data: LiveAgentEvent }) => seen.push(message.data));
    subscription.unsubscribe();

    publishAgentToolCall({ runId: 'r1', toolName: 'search', toolType: 'read', status: 'ok' });

    expect(seen).toHaveLength(0);
  });
});

/** An `ActorDirectory` fake — resolves whatever's in `labels`, records the batched ref set it saw. */
function fakeActorDirectory(
  labels: Record<string, string>,
  seenRefs: string[][] = [],
): ActorDirectory {
  return {
    async resolveDisplay(refs: readonly string[]) {
      seenRefs.push([...refs]);
      const resolved: Record<string, string> = {};
      for (const ref of refs) {
        const label = labels[ref];
        if (label !== undefined) resolved[ref] = label;
      }
      return resolved;
    },
  };
}

describe('DashboardService actorLabel decoration', () => {
  it('leaves actorLabel null on every actor-scoped row when no ActorDirectory is bound', async () => {
    const service = new DashboardService(
      fakeQueries({
        spendByActor: [
          { actorRef: 'user:1', requests: 1, totalTokens: 10, costUsd: 0.1, threadCount: 1 },
        ],
        spendByThread: [
          {
            threadId: 'th1',
            title: 'hi',
            actorRef: 'user:1',
            requests: 1,
            totalTokens: 10,
            costUsd: 0.1,
          },
        ],
        recentThreads: [
          {
            threadId: 'th1',
            title: 'hi',
            actorRef: 'user:1',
            messageCount: 1,
            totalTokens: 10,
            lastActivityAt: '2026-07-05T00:00:00.000Z',
          },
        ],
      }),
    );

    const overview = await service.spend({ fromDay: '2026-07-01', toDay: '2026-07-05' });
    expect(overview.byActor[0]?.actorLabel).toBeNull();

    const topThreads = await service.topThreads({ fromDay: '2026-07-01', toDay: '2026-07-05' });
    expect(topThreads[0]?.actorLabel).toBeNull();

    const threads = await service.recentThreads(10);
    expect(threads[0]?.actorLabel).toBeNull();
  });

  it('resolves actorLabel from a bound ActorDirectory, batching the distinct refs into one call', async () => {
    const seenRefs: string[][] = [];
    const service = new DashboardService(
      fakeQueries({
        spendByActor: [
          { actorRef: 'user:1', requests: 1, totalTokens: 10, costUsd: 0.1, threadCount: 1 },
          { actorRef: 'user:2', requests: 1, totalTokens: 5, costUsd: 0.05, threadCount: 1 },
        ],
      }),
      fakeActorDirectory({ 'user:1': 'Ada Lovelace' }, seenRefs),
    );

    const overview = await service.spend({ fromDay: '2026-07-01', toDay: '2026-07-05' });

    expect(overview.byActor.find((row) => row.actorRef === 'user:1')?.actorLabel).toBe(
      'Ada Lovelace',
    );
    // an unresolved ref (the directory has no entry for it) falls back to null, not an error
    expect(overview.byActor.find((row) => row.actorRef === 'user:2')?.actorLabel).toBeNull();
    expect(seenRefs).toEqual([['user:1', 'user:2']]);
  });

  it('does not call the directory for an empty row set', async () => {
    const seenRefs: string[][] = [];
    const service = new DashboardService(fakeQueries(), fakeActorDirectory({}, seenRefs));

    await service.topThreads({ fromDay: '2026-07-01', toDay: '2026-07-05' });

    expect(seenRefs).toEqual([]);
  });
});

/** An `AgentPricingStore` fake. */
function fakePricingStore(overrides: {
  listCurrentPrices?: CurrentModelPrice[];
  onUpsert?: (input: ModelPriceInput) => void;
}): AgentPricingStore {
  return {
    async upsertModelPrice(input: ModelPriceInput) {
      overrides.onUpsert?.(input);
    },
    async listCurrentPrices() {
      return overrides.listCurrentPrices ?? [];
    },
  };
}

describe('DashboardService pricing CRUD', () => {
  it('listPrices() 501s with a clear message when no AGENT_PRICING_STORE is bound', async () => {
    const service = new DashboardService(fakeQueries());

    await expect(service.listPrices()).rejects.toBeInstanceOf(NotImplementedException);
    await expect(service.listPrices()).rejects.toThrow(/AGENT_PRICING_STORE is bound/);
  });

  it('upsertPrice() 501s with a clear message when no AGENT_PRICING_STORE is bound', async () => {
    const service = new DashboardService(fakeQueries());

    await expect(
      service.upsertPrice({ modelId: 'gpt', inputPricePer1m: 3, outputPricePer1m: 15 }),
    ).rejects.toBeInstanceOf(NotImplementedException);
  });

  it('listPrices() passes through the bound store', async () => {
    const service = new DashboardService(
      fakeQueries(),
      undefined,
      fakePricingStore({
        listCurrentPrices: [
          {
            modelId: 'gpt',
            inputPricePer1m: 3,
            outputPricePer1m: 15,
            effectiveFrom: '2026-07-01T00:00:00.000Z',
          },
        ],
      }),
    );

    const prices = await service.listPrices();
    expect(prices[0]?.modelId).toBe('gpt');
  });

  it('upsertPrice() validates the body minimally before calling the store', async () => {
    const calls: ModelPriceInput[] = [];
    const service = new DashboardService(
      fakeQueries(),
      undefined,
      fakePricingStore({ onUpsert: (input) => calls.push(input) }),
    );

    await service.upsertPrice({ modelId: 'gpt', inputPricePer1m: 3, outputPricePer1m: 15 });
    expect(calls).toEqual([{ modelId: 'gpt', inputPricePer1m: 3, outputPricePer1m: 15 }]);

    await expect(
      service.upsertPrice({ modelId: '', inputPricePer1m: 3, outputPricePer1m: 15 }),
    ).rejects.toThrow();
    await expect(
      service.upsertPrice({ modelId: 'gpt', inputPricePer1m: -1, outputPricePer1m: 15 }),
    ).rejects.toThrow();
    await expect(service.upsertPrice(null)).rejects.toThrow();
  });
});

describe('DashboardService.decideApproval', () => {
  it('501s with a clear message when no AGENT_APPROVAL_PORT is bound', async () => {
    const service = new DashboardService(fakeQueries());

    await expect(service.decideApproval('tc1', { approved: true }, undefined)).rejects.toThrow(
      NotImplementedException,
    );
    await expect(service.decideApproval('tc1', { approved: true }, undefined)).rejects.toThrow(
      /AGENT_APPROVAL_PORT is bound/,
    );
  });

  it('routes an approve decision through the bound port, carrying executedByRef when given', async () => {
    const calls: { method: 'approve' | 'reject'; toolCallId: string; opts?: unknown }[] = [];
    const service = new DashboardService(
      fakeQueries(),
      undefined,
      undefined,
      fakeApprovalPort(calls),
    );

    await service.decideApproval('tc1', { approved: true }, 'user:ops-1');

    expect(calls).toEqual([
      { method: 'approve', toolCallId: 'tc1', opts: { executedByRef: 'user:ops-1' } },
    ]);
  });

  it('routes a reject decision (with reason) through the bound port, omitting executedByRef when absent', async () => {
    const calls: { method: 'approve' | 'reject'; toolCallId: string; opts?: unknown }[] = [];
    const service = new DashboardService(
      fakeQueries(),
      undefined,
      undefined,
      fakeApprovalPort(calls),
    );

    await service.decideApproval('tc1', { approved: false, reason: 'not now' }, undefined);

    expect(calls).toEqual([{ method: 'reject', toolCallId: 'tc1', opts: { reason: 'not now' } }]);
  });

  it('validates the body BEFORE trusting it, even with a bound port', async () => {
    const service = new DashboardService(fakeQueries(), undefined, undefined, fakeApprovalPort());

    await expect(service.decideApproval('tc1', { approved: 'yes' }, undefined)).rejects.toThrow();
    await expect(service.decideApproval('tc1', null, undefined)).rejects.toThrow();
  });
});

/**
 * The API controller with a call-recording approval port behind it, plus the two decider-attribution
 * seams under test: the explicit `approvalActorRef` extractor and the app's `ActorResolver` fallback.
 */
function buildApiController(
  overrides: {
    extractor?: (req: unknown) => string | undefined;
    resolver?: ActorResolver;
  } = {},
) {
  const calls: { method: 'approve' | 'reject'; toolCallId: string; opts?: unknown }[] = [];
  const service = new DashboardService(
    fakeQueries(),
    undefined,
    undefined,
    fakeApprovalPort(calls),
  );
  const controller = new AgentApiController(service, overrides.extractor, overrides.resolver);
  return { calls, controller };
}

describe('AgentApiController decider attribution (POST approvals/:toolCallId → executedByRef)', () => {
  it("defaults to the AgentModule actor resolver — the resolved actor's id stamps executedByRef", async () => {
    const { calls, controller } = buildApiController({
      resolver: { resolve: () => ({ id: 'user-7', roles: ['ADMIN'] }) },
    });

    await controller.decideApproval('tc1', { approved: true }, { headers: {} });

    expect(calls).toEqual([
      { method: 'approve', toolCallId: 'tc1', opts: { executedByRef: 'user-7' } },
    ]);
  });

  it('a throwing resolver (unauthenticated request) omits executedByRef instead of failing the decision', async () => {
    const { calls, controller } = buildApiController({
      resolver: {
        resolve: () => {
          throw new Error('no principal on request');
        },
      },
    });

    await controller.decideApproval('tc1', { approved: true }, {});

    expect(calls).toEqual([{ method: 'approve', toolCallId: 'tc1', opts: {} }]);
  });

  it('an explicit approvalActorRef override wins outright over the resolver', async () => {
    const { calls, controller } = buildApiController({
      extractor: () => 'console-9',
      resolver: { resolve: () => ({ id: 'user-7', roles: ['ADMIN'] }) },
    });

    await controller.decideApproval('tc1', { approved: false, reason: 'nope' }, {});

    expect(calls).toEqual([
      { method: 'reject', toolCallId: 'tc1', opts: { executedByRef: 'console-9', reason: 'nope' } },
    ]);
  });

  it('neither an override nor a resolver → executedByRef omitted (the pre-fallback behavior)', async () => {
    const { calls, controller } = buildApiController();

    await controller.decideApproval('tc1', { approved: true }, {});

    expect(calls).toEqual([{ method: 'approve', toolCallId: 'tc1', opts: {} }]);
  });
});
