import { describe, expect, it } from 'vitest';
import { InMemoryAgentStore } from './in-memory-store.js';

const IMAGE = { url: 'https://example.test/a.png', contentType: 'image/png', name: 'a.png' };

/**
 * `referencedMediaIds` is the half of attachment collection only the lib can answer: of the media
 * ids a host found in its own inventory, which are still carried by a message that exists. The
 * host owns the bytes and cannot see the transcript; this side sees the transcript and never
 * touches the bytes.
 *
 * Every case here is re-derived from the surviving message rows on each call rather than read off
 * a flag written at send time — `truncateFrom` (which is what regenerating a turn does) makes a
 * reference disappear, and a one-way flag would then pin bytes nobody can reach for ever.
 */
describe('InMemoryAgentStore — which media a live message still references', () => {
  it('answers with the referenced subset and ignores ids nothing carries', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: { id: 'u1' } });
    await store.appendMessage({
      threadId: thread.id,
      role: 'user',
      content: 'look at this',
      attachments: [{ mediaId: 'sent', ...IMAGE }],
    });

    expect(await store.referencedMediaIds('u1', ['sent', 'never-sent'])).toEqual(['sent']);
  });

  it('re-derives after truncateFrom, so a regenerated turn frees its media again', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: { id: 'u1' } });
    const message = await store.appendMessage({
      threadId: thread.id,
      role: 'user',
      content: 'look at this',
      attachments: [{ mediaId: 'sent', ...IMAGE }],
    });
    expect(await store.referencedMediaIds('u1', ['sent'])).toEqual(['sent']);

    await store.truncateFrom(thread.id, message.id);

    expect(await store.referencedMediaIds('u1', ['sent'])).toEqual([]);
  });

  it('never reports another actor’s reference, so an id that is not yours reads like one that does not exist', async () => {
    const store = new InMemoryAgentStore();
    const mine = await store.createThread({ actor: { id: 'u1' } });
    const theirs = await store.createThread({ actor: { id: 'u2' } });
    await store.appendMessage({
      threadId: mine.id,
      role: 'user',
      content: 'mine',
      attachments: [{ mediaId: 'mine', ...IMAGE }],
    });
    await store.appendMessage({
      threadId: theirs.id,
      role: 'user',
      content: 'theirs',
      attachments: [{ mediaId: 'theirs', ...IMAGE }],
    });

    expect(await store.referencedMediaIds('u1', ['mine', 'theirs', 'imaginary'])).toEqual(['mine']);
  });

  it('returns each id once, in the order asked, however many messages carry it', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: { id: 'u1' } });
    for (const content of ['first', 'second']) {
      await store.appendMessage({
        threadId: thread.id,
        role: 'user',
        content,
        attachments: [{ mediaId: 'b', ...IMAGE }],
      });
    }
    await store.appendMessage({
      threadId: thread.id,
      role: 'user',
      content: 'third',
      attachments: [{ mediaId: 'a', ...IMAGE }],
    });

    expect(await store.referencedMediaIds('u1', ['b', 'a', 'b'])).toEqual(['b', 'a']);
  });

  it('counts a message waiting in the thread’s queue — sent, just not run yet', async () => {
    const store = new InMemoryAgentStore();
    const mine = await store.createThread({ actor: { id: 'q-1' } });
    const theirs = await store.createThread({ actor: { id: 'q-2' } });
    await store.enqueueMessage({
      threadId: mine.id,
      actor: { id: 'q-1' },
      content: 'look at this next',
      attachments: [{ mediaId: 'queued', ...IMAGE }],
    });
    await store.enqueueMessage({
      threadId: theirs.id,
      actor: { id: 'q-2' },
      content: 'theirs, waiting',
      attachments: [{ mediaId: 'queued-theirs', ...IMAGE }],
    });

    // Collecting it now would fail the turn it is waiting to start; another actor's queue stays
    // invisible, exactly like another actor's transcript.
    expect(await store.referencedMediaIds('q-1', ['queued', 'queued-theirs'])).toEqual(['queued']);
  });

  it('re-derives from the queue too: a removed or edited queued message frees its media', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: { id: 'q-3' } });
    const removed = await store.enqueueMessage({
      threadId: thread.id,
      actor: { id: 'q-3' },
      content: 'never mind',
      attachments: [{ mediaId: 'removed', ...IMAGE }],
    });
    const edited = await store.enqueueMessage({
      threadId: thread.id,
      actor: { id: 'q-3' },
      content: 'with a picture',
      attachments: [{ mediaId: 'dropped', ...IMAGE }],
    });
    expect(await store.referencedMediaIds('q-3', ['removed', 'dropped'])).toEqual([
      'removed',
      'dropped',
    ]);

    await store.removeQueuedMessage(removed.id);
    await store.updateQueuedMessage(edited.id, { attachments: null });

    expect(await store.referencedMediaIds('q-3', ['removed', 'dropped'])).toEqual([]);
  });
});
