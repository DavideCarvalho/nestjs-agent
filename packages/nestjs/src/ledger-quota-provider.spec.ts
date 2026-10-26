import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it, vi } from 'vitest';
import { LedgerQuotaProvider } from './ledger-quota-provider.js';

const actor = { id: 'u1', roles: [] as string[] };

/** One estimated row (a Bedrock turn priced off the table) and one provider-reported row. */
async function ledger() {
  const store = new InMemoryAgentStore();
  const thread = await store.createThread({ actor });
  await store.recordUsage({
    threadId: thread.id,
    actorRef: 'u1',
    modelId: 'bedrock-model',
    purpose: 'chat',
    usage: { inputTokens: 10_605, outputTokens: 5 },
    costUsd: 0.038268,
    costSource: 'estimate',
  });
  await store.recordUsage({
    threadId: thread.id,
    actorRef: 'u1',
    modelId: 'gateway-model',
    purpose: 'chat',
    usage: { inputTokens: 10, outputTokens: 10 },
    costUsd: 0.01,
    costSource: 'provider',
  });
  return store;
}

describe('LedgerQuotaProvider USD windows', () => {
  it('count estimated cost by default, so a USD ceiling binds on a provider that reports none', async () => {
    const provider = new LedgerQuotaProvider(await ledger(), { day: { usd: 0.04 } });
    const report = await provider.report({ actor });
    const day = report.windows.find((window) => window.period === 'day');
    expect(day?.usedUsd).toBeCloseTo(0.048268, 9);
    expect(report.blocked).toMatchObject({ period: 'day' });
  });

  it('with countEstimatedCost: false count provider-reported cost only', async () => {
    const provider = new LedgerQuotaProvider(
      await ledger(),
      { day: { usd: 0.04 } },
      { countEstimatedCost: false },
    );
    const report = await provider.report({ actor });
    const day = report.windows.find((window) => window.period === 'day');
    expect(day?.usedUsd).toBeCloseTo(0.01, 9);
    expect(report.blocked).toBeUndefined();
  });
});

describe('LedgerQuotaProvider reads', () => {
  it('reads the day and month windows in one store call when the store sums several at once', async () => {
    const store = await ledger();
    const windows = vi.fn(async (_actorRef: string, ranges: readonly { fromDay: string }[]) =>
      ranges.map(() => ({ usedTokens: 7, costUsd: 0.5, estimatedCostUsd: 0.25 })),
    );
    const quotaToday = vi.spyOn(store, 'quotaToday');
    const usageBetween = vi.spyOn(store, 'usageBetween');
    const now = new Date('2026-10-15T12:00:00.000Z');
    const provider = new LedgerQuotaProvider(Object.assign(store, { usageWindows: windows }), {
      day: { tokens: 5 },
    });

    const report = await provider.report({ actor, now });

    expect(windows).toHaveBeenCalledTimes(1);
    expect(windows.mock.calls[0]?.[1]).toEqual([
      expect.objectContaining({ fromDay: '2026-10-15', toDay: '2026-10-15' }),
      expect.objectContaining({ fromDay: '2026-10-01', toDay: '2026-10-31' }),
    ]);
    expect(quotaToday).not.toHaveBeenCalled();
    expect(usageBetween).not.toHaveBeenCalled();
    expect(
      report.windows.map((window) => [window.period, window.usedTokens, window.usedUsd]),
    ).toEqual([
      ['day', 7, 0.5],
      ['month', 7, 0.5],
    ]);
    expect(report.blocked).toMatchObject({ period: 'day' });
  });

  it('asks window by window a store that sums one range at a time', async () => {
    const store = await ledger();
    const report = await new LedgerQuotaProvider(store).report({ actor });
    expect(report.windows.map((window) => [window.period, window.usedTokens])).toEqual([
      ['day', 10_630],
      ['month', 10_630],
    ]);
  });
});
