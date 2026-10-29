import { describe, it } from 'vitest';
import { InMemoryGovernanceQueries } from './in-memory-governance-queries.js';
import { InMemoryAgentStore } from './in-memory-store.js';
import { USAGE_LEDGER_STORE_CONTRACT } from './usage-ledger-store-contract.js';

describe('InMemoryAgentStore — usage ledger and run timings contract', () => {
  for (const contractCase of USAGE_LEDGER_STORE_CONTRACT) {
    it(contractCase.name, async () => {
      const store = new InMemoryAgentStore();
      const actor = { id: 'u1', roles: [] };
      const thread = await store.createThread({ actor });
      await contractCase.run({
        store,
        governance: new InMemoryGovernanceQueries(store),
        threadId: thread.id,
        actorRef: actor.id,
      });
    });
  }
});
