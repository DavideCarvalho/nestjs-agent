import type { UpdateThreadInput } from '@dudousxd/nestjs-agent-core';
import { describe, expect, it } from 'vitest';
import { InMemoryAgentStore } from './in-memory-store.js';

/**
 * Everything `updateThread` accepts has to come back out of `getThread`. `defaultAgent` decides
 * which agent answers the next turn on a thread, so a store that takes the write and can't return
 * it doesn't fail — it quietly answers as somebody else, which no caller can see.
 *
 * The fixture is typed `Required<UpdateThreadInput>` on purpose, the same way
 * `message-fields.spec.ts` is: adding a field to the patch then fails to COMPILE until it is
 * covered here. The sibling checks live in each SQL adapter's `store.db.spec.ts`, because a column
 * is the half an in-memory map cannot have.
 */
const EVERY_PATCH_FIELD: Required<UpdateThreadInput> = {
  title: 'Renamed',
  defaultAgent: 'researcher',
};

describe('InMemoryAgentStore — a thread patch round-trips every field it was given', () => {
  it('returns all of them from getThread', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: { id: 'u1', roles: ['ADMIN'] } });

    await store.updateThread(thread.id, EVERY_PATCH_FIELD);

    expect(await store.getThread(thread.id)).toMatchObject(EVERY_PATCH_FIELD);
  });

  it('answers the default agent from a summary-shaped read too', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: { id: 'u1', roles: ['ADMIN'] } });
    expect(await store.defaultAgentForThread(thread.id)).toBeNull();

    await store.updateThread(thread.id, { defaultAgent: 'researcher' });

    expect(await store.defaultAgentForThread(thread.id)).toBe('researcher');
    expect(await store.defaultAgentForThread('missing')).toBeNull();
  });
});
