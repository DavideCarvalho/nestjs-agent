import type {
  ActorSpendRow,
  AgentGovernanceQueries,
  GovernanceRange,
  ModelSpendRow,
  ThreadSpendRow,
  UsageTrendPoint,
} from '@dudousxd/nestjs-agent-core';
import { AGENT_GOVERNANCE_QUERIES } from '@dudousxd/nestjs-agent-core';
import type { ExtensionContext } from '@dudousxd/nestjs-telescope';
import { describe, expect, it } from 'vitest';
import {
  agentActorSpendTableProvider,
  agentModelSpendTableProvider,
  agentSpendByModelProvider,
  agentSpendTotalProvider,
  agentTokensTotalProvider,
  agentTopThreadsTableProvider,
  agentUsageTrendProvider,
  resolveRange,
  shiftUtcDay,
  toActorSpendRows,
  toActorSpendSegments,
  toModelSpendRows,
  toModelSpendSegments,
  toThreadSpendRows,
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
      return [];
    },
    async recentThreads(_limit: number) {
      return [];
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
