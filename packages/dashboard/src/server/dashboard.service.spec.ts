import type {
  ActorSpendRow,
  AgentGovernanceQueries,
  AgentPricingStore,
  CurrentModelPrice,
  GovernanceRange,
  ModelPriceInput,
  ModelSpendRow,
  RecentRunRow,
  RunAgentBreakdownRow,
  RunErrorBreakdownRow,
  RunMetrics,
  RunTrendPoint,
  ThreadActivityRow,
  ThreadSpendRow,
  ToolCallActivityRow,
  UsageTrendPoint,
} from '@dudousxd/nestjs-agent-core';
import { publishAgentToolCall } from '@dudousxd/nestjs-agent-core';
import { NotImplementedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { ActorDirectory } from './actor-directory';
import { DashboardService, type LiveAgentEvent } from './dashboard.service';

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

  it('streamEvents() forwards a live agent diagnostics event to a subscriber', async () => {
    const service = new DashboardService(fakeQueries());
    const seen: LiveAgentEvent[] = [];
    const subscription = service.streamEvents().subscribe((message) => seen.push(message.data));

    publishAgentToolCall({ runId: 'r1', toolName: 'search', toolType: 'read', status: 'ok' });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.event).toBe('tool-call');
    expect(seen[0]?.payload.toolName).toBe('search');

    subscription.unsubscribe();
  });

  it('streamEvents() stops forwarding after unsubscribe', () => {
    const service = new DashboardService(fakeQueries());
    const seen: LiveAgentEvent[] = [];
    const subscription = service.streamEvents().subscribe((message) => seen.push(message.data));
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
