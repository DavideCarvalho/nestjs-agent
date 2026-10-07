import { InMemoryChannelStore } from '@dudousxd/nestjs-agent-core';
import { describe, expect, it } from 'vitest';
import { CHANNEL_STORE_CONTRACT } from './channel-store-contract.js';

describe('InMemoryChannelStore — the channel store contract', () => {
  for (const contractCase of CHANNEL_STORE_CONTRACT) {
    it(contractCase.name, async () => contractCase.run({ store: new InMemoryChannelStore() }));
  }

  it('forgets the oldest keys past maxEntries', async () => {
    const store = new InMemoryChannelStore(2);
    await store.claim('a', 60_000);
    await store.claim('b', 60_000);
    await store.claim('c', 60_000);
    expect(await store.claim('a', 60_000)).toBe(true);
    expect(await store.claim('c', 60_000)).toBe(false);
  });
});
