import { describe, expect, it } from 'vitest';
import { AGENT_RUNNER, AGENT_STORE } from './index.js';

describe('tokens', () => {
  it('uses the global symbol registry so cross-copy DI resolves the same token', () => {
    expect(AGENT_STORE).toBe(Symbol.for('@dudousxd/nestjs-agent:store'));
    expect(AGENT_RUNNER).toBe(Symbol.for('@dudousxd/nestjs-agent:runner'));
  });
});
