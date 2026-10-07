import { ACTION_PROPOSAL_STORE_CONTRACT } from '@dudousxd/nestjs-agent-testing';
import { describe, it } from 'vitest';
import { InMemoryActionProposalStore } from './in-memory-action-proposal-store.js';
import { InMemoryAgentStore } from './in-memory-store.js';

for (const Store of [InMemoryActionProposalStore, InMemoryAgentStore]) {
  describe(`${Store.name} contract`, () => {
    for (const test of ACTION_PROPOSAL_STORE_CONTRACT) {
      it(test.name, async () => {
        let now = 1000;
        await test.run({
          store: new Store({ clock: () => now }),
          setNow: (value) => {
            now = value;
          },
        });
      });
    }
  });
}
