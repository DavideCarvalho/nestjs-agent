import { InMemoryConfirmTokenStore } from '@dudousxd/nestjs-agent-core';
import { describe, it } from 'vitest';
import { CONFIRM_TOKEN_STORE_CONTRACT } from './confirm-token-store-contract.js';

describe('InMemoryConfirmTokenStore — the confirm-token store contract', () => {
  for (const contractCase of CONFIRM_TOKEN_STORE_CONTRACT) {
    it(contractCase.name, async () => {
      const store = new InMemoryConfirmTokenStore();
      const held = store as unknown as { claims: Map<string, Record<string, unknown>> };
      await contractCase.run({ store, rows: async () => [...held.claims.values()] });
    });
  }
});
