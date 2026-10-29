import { describe, it } from 'vitest';
import { FORK_THREAD_CONTRACT } from './fork-thread-contract.js';
import { InMemoryAgentStore } from './in-memory-store.js';

describe('FORK_THREAD_CONTRACT — InMemoryAgentStore', () => {
  for (const contractCase of FORK_THREAD_CONTRACT) {
    it(contractCase.name, async () => contractCase.run({ store: new InMemoryAgentStore() }));
  }
});
