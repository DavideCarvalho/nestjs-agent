import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { channelName } from '@dudousxd/nestjs-diagnostics';
import { describe, expect, it } from 'vitest';
import { publishAgentRunStarted } from './index.js';

describe('diagnostics', () => {
  it('emits on aviary:agent:run.started', () => {
    const name = channelName('agent', 'run.started');
    const seen: unknown[] = [];
    const handler = (message: unknown) => seen.push(message);
    subscribe(name, handler);
    try {
      publishAgentRunStarted({ runId: 'r1', threadId: 't1', actorId: 'u1' });
    } finally {
      unsubscribe(name, handler);
    }
    expect(seen).toHaveLength(1);
    expect(seen[0]).toMatchObject({ payload: { runId: 'r1', threadId: 't1', actorId: 'u1' } });
  });
});
