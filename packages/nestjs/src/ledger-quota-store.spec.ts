import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import { utcDay } from './agent-deps.js';
import { LedgerQuotaStore } from './ledger-quota-store.js';

describe('LedgerQuotaStore', () => {
  it('enforces the limit off the persisted ledger, and treats bump as a no-op', async () => {
    const store = new InMemoryAgentStore();
    const day = utcDay();
    const thread = await store.createThread({ actor: { id: 'u1' } });
    const quota = new LedgerQuotaStore(store, 100);

    expect(await quota.check('u1', day)).toEqual({
      usedTokens: 0,
      limitTokens: 100,
      withinLimit: true,
    });

    await store.recordUsage({
      threadId: thread.id,
      actorRef: 'u1',
      modelId: 'm',
      purpose: 'chat',
      usage: { inputTokens: 60, outputTokens: 50 },
    });
    // bump must not double-count — recordUsage already wrote the tokens the ledger sums.
    await quota.bump('u1', day, 999);

    const after = await quota.check('u1', day);
    expect(after.usedTokens).toBe(110);
    expect(after.withinLimit).toBe(false);
  });
});
