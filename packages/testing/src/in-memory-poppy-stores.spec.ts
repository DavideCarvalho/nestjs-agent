import { InMemoryPoppyConnectionStore, InMemoryPoppyStore } from '@dudousxd/nestjs-agent-core';
import { describe, it } from 'vitest';
import { POPPY_CONNECTION_STORE_CONTRACT } from './poppy-connection-store-contract.js';
import { POPPY_STORE_CONTRACT } from './poppy-store-contract.js';

describe('InMemoryPoppyStore — the Poppy store contract', () => {
  for (const contractCase of POPPY_STORE_CONTRACT) {
    it(contractCase.name, async () => contractCase.run({ store: new InMemoryPoppyStore() }));
  }
});

describe('InMemoryPoppyConnectionStore — the Poppy connection store contract', () => {
  for (const contractCase of POPPY_CONNECTION_STORE_CONTRACT) {
    it(contractCase.name, async () =>
      contractCase.run({ store: new InMemoryPoppyConnectionStore() }));
  }
});
