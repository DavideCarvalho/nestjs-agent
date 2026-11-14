import { expect, it, vi } from 'vitest';
import { AgentClient } from './client.js';
it('uses scoped proposal endpoints and sends only decision body fields', async () => {
  const fetch = vi.fn(
    async (_url: RequestInfo | URL, _options?: RequestInit) =>
      new Response(
        JSON.stringify(
          String(_url).includes('/action-proposals?')
            ? {
                data: [],
                meta: { nextCursor: null, prevCursor: null, hasNext: false, hasPrev: false },
              }
            : { status: 'applied' },
        ),
        {
          headers: { 'content-type': 'application/json' },
        },
      ),
  );
  const client = new AgentClient({ fetch });
  await client.listActionProposals({ threadId: 'thread/a' });
  await client.approveActionProposal({ threadId: 'thread/a', proposalId: 'p ?', remember: true });
  await client.rejectActionProposal({ threadId: 'thread/a', proposalId: 'p ?', reason: 'No' });
  expect(String(fetch.mock.calls[0]?.[0])).toContain('/threads/thread%2Fa/action-proposals');
  expect(String(fetch.mock.calls[1]?.[0])).toContain('/p%20%3F/approve');
  expect(JSON.parse(String(fetch.mock.calls[1]?.[1]?.body))).toEqual({ remember: true });
  expect(JSON.parse(String(fetch.mock.calls[2]?.[1]?.body))).toEqual({ reason: 'No' });
});

it('recognizes safe text decision JSON without treating it as a streaming run', async () => {
  const response = {
    threadId: 'thread',
    proposalDecision: { status: 'applied' },
    text: 'Approved and queued.',
  };
  const client = new AgentClient({
    fetch: async () =>
      new Response(JSON.stringify(response), { headers: { 'content-type': 'application/json' } }),
  });
  const result = await client.openChatStream({ body: { message: 'confirm' } });
  expect(result.proposalDecision).toEqual(response);
  expect(result.runId).toBeUndefined();
});

const page = (data: unknown[], nextCursor: string | null) =>
  new Response(
    JSON.stringify({
      data,
      meta: { nextCursor, prevCursor: null, hasNext: nextCursor !== null, hasPrev: false },
    }),
    { headers: { 'content-type': 'application/json' } },
  );

it('traverses scoped pages even when the authorized first page is empty', async () => {
  const fetch = vi.fn(async (_url: RequestInfo | URL) =>
    fetch.mock.calls.length === 1 ? page([], 'opaque-1') : page([{ id: 'latest' }], null),
  );
  const client = new AgentClient({ fetch });
  expect(await client.listActionProposals({ threadId: 'thread/a' })).toEqual([{ id: 'latest' }]);
  expect(fetch).toHaveBeenCalledTimes(2);
  const first = new URL(String(fetch.mock.calls[0]?.[0]), 'https://test.invalid');
  expect(first.searchParams.get('after')).toBeNull();
  expect(first.searchParams.get('first')).toBe('1000');
  const next = new URL(String(fetch.mock.calls[1]?.[0]), 'https://test.invalid');
  expect(next.searchParams.get('after')).toBe('opaque-1');
});

it('rejects a repeated pagination cursor instead of looping or hiding later proposals', async () => {
  const fetch = vi.fn(async () => page([], 'same'));
  await expect(
    new AgentClient({ fetch }).listActionProposals({ threadId: 'thread' }),
  ).rejects.toThrow('cursor');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('rejects an answer that is not a cursor page, such as a pre-4.0 bare array', async () => {
  const fetch = vi.fn(
    async () => new Response('[]', { headers: { 'content-type': 'application/json' } }),
  );
  await expect(
    new AgentClient({ fetch }).listActionProposals({ threadId: 'thread' }),
  ).rejects.toThrow('Invalid action proposal page');
});

it('rejects a page whose meta has no nextCursor instead of treating it as the last page', async () => {
  const fetch = vi.fn(
    async () =>
      new Response(JSON.stringify({ data: [], meta: { hasNext: false } }), {
        headers: { 'content-type': 'application/json' },
      }),
  );
  await expect(
    new AgentClient({ fetch }).listActionProposals({ threadId: 'thread' }),
  ).rejects.toThrow('Invalid action proposal page');
});
