import { describe, it } from 'vitest';
import { BLANK_ASSISTANT_HISTORY_CONTRACT } from './blank-assistant-history-contract.js';
import { InMemoryAgentStore } from './in-memory-store.js';

describe('BLANK_ASSISTANT_HISTORY_CONTRACT — InMemoryAgentStore', () => {
  for (const contractCase of BLANK_ASSISTANT_HISTORY_CONTRACT) {
    it(contractCase.name, async () => contractCase.run({ store: new InMemoryAgentStore() }));
  }
});
