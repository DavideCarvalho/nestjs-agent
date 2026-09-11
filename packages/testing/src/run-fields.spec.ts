import type { RecordRunStartInput } from '@dudousxd/nestjs-agent-core';
import { describe, expect, it } from 'vitest';
import { InMemoryAgentStore } from './in-memory-store.js';

/**
 * Everything `recordRunStart` is handed has to come back out of the row the governance read-model
 * feeds on. `parentRunId` is the case that made this file: every store declared its own structural
 * parameter rather than the SPI's input, so the field was added, passed by both runners, and
 * dropped by all three adapters without anything failing.
 *
 * The fixture is typed `Required<RecordRunStartInput>` on purpose, the same way
 * `message-fields.spec.ts` and `thread-fields.spec.ts` are: a new field on the input then fails to
 * COMPILE here until the row can name it. The sibling checks live in each SQL adapter's
 * `store.db.spec.ts`, because a column is the half an in-memory map cannot have.
 */
function everyRunStartField(threadId: string): Required<RecordRunStartInput> {
  return {
    runId: 'run-child',
    threadId,
    actorRef: 'u1',
    agentName: 'researcher',
    parentRunId: 'run-parent',
    promptHash: 'a'.repeat(64),
  };
}

describe('InMemoryAgentStore — a recorded run round-trips every field it was started with', () => {
  it('returns all of them from the governance feed', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: { id: 'u1' } });
    const started = everyRunStartField(thread.id);

    await store.recordRunStart(started);

    expect(store.governanceRuns().find((run) => run.runId === started.runId)).toMatchObject({
      agentName: started.agentName,
      parentRunId: started.parentRunId,
      promptHash: started.promptHash,
    });
  });

  it('leaves the parent unset for a turn nobody delegated', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: { id: 'u1' } });

    await store.recordRunStart({ runId: 'run-root', threadId: thread.id, actorRef: 'u1' });

    expect(store.governanceRuns()[0]?.parentRunId).toBeUndefined();
  });
});
