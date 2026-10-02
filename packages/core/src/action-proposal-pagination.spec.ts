import { expect, it } from 'vitest';
import { validateActionProposalListQuery } from './action-proposal-transitions.js';
import { InMemoryActionProposalStore } from './in-memory-action-proposal-store.js';
it('paginates exact logical ids without dropping same-time Unicode ties', async () => {
  const store = new InMemoryActionProposalStore({ clock: () => 1000 });
  const scope = { tenantRef: null, actorRef: 'a', threadId: 't' };
  for (const id of ['z', '😀', '\uE000'])
    await store.createActionProposal({
      ...scope,
      id,
      originRunId: 'r',
      originMessageId: 'm',
      originToolCallId: 'c',
      toolName: 'send',
      input: null,
      confirmation: { title: 'Send', verb: 'Send' },
      approver: 'requester',
      expiresAt: null,
      idempotencyKey: id,
    });
  const first = await store.listActionProposals(scope, { limit: 2 });
  expect(first.map((row) => row.id)).toEqual(['z', '😀']);
  const last = first.at(-1);
  if (!last) throw new Error('Missing cursor');
  expect(
    (
      await store.listActionProposals(scope, {
        limit: 2,
        after: { createdAt: last.createdAt, id: last.id },
      })
    ).map((row) => row.id),
  ).toEqual(['\uE000']);
  expect(
    await store.listActionProposals(
      { ...scope, tenantRef: 'other' },
      { after: { createdAt: last.createdAt, id: last.id } },
    ),
  ).toEqual([]);
});
it('rejects malformed list cursors', () => {
  for (const after of [
    null,
    [],
    { id: 'p' },
    { createdAt: 1, id: '' },
    { createdAt: 1, id: 'p', forged: true },
    { createdAt: 1.5, id: 'p' },
  ]) {
    expect(() => validateActionProposalListQuery(JSON.parse(JSON.stringify({ after })))).toThrow();
  }
});
