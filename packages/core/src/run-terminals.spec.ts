import type { RecordRunEndInput } from '@dudousxd/nestjs-agent-core';
import { describe, expect, it } from 'vitest';
import { type GovernanceRunRow, InMemoryAgentStore } from './in-memory-store.js';

/**
 * Every terminal the SPI can hand a store has to be NAMEABLE by the row it lands in. The
 * `satisfies` is the whole check: a store's `recordRunEnd` declaring a narrower parameter still
 * accepts `'cancelled'` and writes it through (method parameters are bivariant), so at runtime
 * nothing is wrong — but the row type tells every reader a cancelled run is impossible, and a
 * reliability read then has no way to leave a user pressing Stop out of its failure count.
 */
const TERMINALS = [
  'completed',
  'failed',
  'cancelled',
] as const satisfies readonly (GovernanceRunRow['status'] & RecordRunEndInput['status'])[];

describe('InMemoryAgentStore — the terminals a run can settle on', () => {
  it('records and reads back each of them', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: { id: 'u1' } });

    for (const status of TERMINALS) {
      const runId = `run-${status}`;
      await store.recordRunStart({ runId, threadId: thread.id, actorRef: 'u1' });
      await store.recordRunEnd({ runId, status });

      expect(store.governanceRuns().find((run) => run.runId === runId)?.status).toBe(status);
    }
  });
});
