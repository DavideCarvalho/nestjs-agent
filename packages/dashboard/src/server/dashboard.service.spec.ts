import type {
  ActorSpendRow,
  AgentGovernanceQueries,
  GovernanceRange,
  ModelSpendRow,
  ThreadActivityRow,
  ThreadSpendRow,
  ToolCallActivityRow,
  UsageTrendPoint,
} from '@dudousxd/nestjs-agent-core';
import { publishAgentToolCall } from '@dudousxd/nestjs-agent-core';
import { describe, expect, it } from 'vitest';
import { DashboardService, type LiveAgentEvent } from './dashboard.service';

interface QueriesOverrides {
  record?: (call: string) => void;
  spendByModel?: ModelSpendRow[];
  spendByActor?: ActorSpendRow[];
  spendByThread?: ThreadSpendRow[];
  usageTrend?: UsageTrendPoint[];
  recentToolCalls?: ToolCallActivityRow[];
  recentThreads?: ThreadActivityRow[];
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
