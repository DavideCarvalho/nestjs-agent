import { describe, expect, it } from 'vitest';
import { InMemoryAgentStore } from './in-memory-store.js';
import { EVERY_MESSAGE_FIELD } from './message-fixture.js';

/**
 * Everything `appendMessage` accepts has to come back out of `getThread`. A field an adapter
 * silently drops is invisible until a user notices their attachment is gone from a thread they
 * reopened — `attachments` was exactly that here and in the Drizzle store, persisted only by the
 * MikroORM adapter, so one conversation round-tripped differently per adapter with nothing logged.
 *
 * The fixture is typed `Required<Omit<AppendMessageInput, …>>` on purpose: adding an optional field
 * to the input then fails to COMPILE until it is covered here, which is the only version of this
 * check that keeps working without someone remembering it exists.
 */
describe('InMemoryAgentStore — a message round-trips every field it was given', () => {
  it('returns all of them from getThread', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: { id: 'u1', roles: ['ADMIN'] } });

    await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: 'here it is',
      ...EVERY_MESSAGE_FIELD,
    });

    const [message] = (await store.getThread(thread.id))?.messages ?? [];
    expect(message).toMatchObject(EVERY_MESSAGE_FIELD);
  });

  it('carries all of them onto a fork, which copies the conversation rather than summarising it', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: { id: 'u1', roles: ['ADMIN'] } });
    const appended = await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: 'here it is',
      ...EVERY_MESSAGE_FIELD,
    });

    const fork = await store.forkThread(thread.id, appended.id);

    const [copied] = (await store.getThread(fork.id))?.messages ?? [];
    expect(copied).toMatchObject(EVERY_MESSAGE_FIELD);
  });
});
