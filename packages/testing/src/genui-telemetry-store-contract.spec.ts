import { describe, it } from 'vitest';
import { GENUI_TELEMETRY_STORE_CONTRACT } from './genui-telemetry-store-contract.js';
import { InMemoryGovernanceQueries } from './in-memory-governance-queries.js';
import { InMemoryAgentStore } from './in-memory-store.js';

describe('InMemoryAgentStore — genui telemetry contract', () => {
  for (const contractCase of GENUI_TELEMETRY_STORE_CONTRACT) {
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
