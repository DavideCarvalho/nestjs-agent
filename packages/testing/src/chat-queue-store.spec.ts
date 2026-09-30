import { isChatQueueStore } from '@dudousxd/nestjs-agent-core';
import { describe, expect, it } from 'vitest';
import { CHAT_QUEUE_STORE_CONTRACT } from './chat-queue-store-contract.js';
import { InMemoryAgentStore } from './in-memory-store.js';

describe('InMemoryAgentStore — the chat queue contract', () => {
  it('is a ChatQueueStore', () => {
    expect(isChatQueueStore(new InMemoryAgentStore())).toBe(true);
  });

  for (const contractCase of CHAT_QUEUE_STORE_CONTRACT) {
    it(contractCase.name, async () => {
      const store = new InMemoryAgentStore();
      const thread = await store.createThread({ actor: { id: 'contract-actor' } });
      await contractCase.run({ store, threadId: thread.id });
    });
  }
});
