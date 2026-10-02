import { expect, it, vi } from 'vitest';
import { AgentClient } from './client.js';
it('uses scoped proposal endpoints and sends only decision body fields', async () => {
  const fetch = vi.fn(
    async (_url: RequestInfo | URL, _options?: RequestInit) =>
      new Response(
        JSON.stringify(String(_url).endsWith('/action-proposals') ? [] : { status: 'applied' }),
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

it('traverses scoped pages even when the authorized first page is empty', async () => {
  const cursor = { createdAt: 10, id: 'old\u0000row' };
  const fetch = vi.fn(
    async (_url: RequestInfo | URL) =>
      new Response(JSON.stringify(fetch.mock.calls.length === 1 ? [] : [{ id: 'latest' }]), {
        headers: {
          'content-type': 'application/json',
          ...(fetch.mock.calls.length === 1
            ? { 'X-Action-Proposals-Next': encodeURIComponent(JSON.stringify(cursor)) }
            : {}),
        },
      }),
  );
  const client = new AgentClient({ fetch });
  expect(await client.listActionProposals({ threadId: 'thread/a' })).toEqual([{ id: 'latest' }]);
  expect(fetch).toHaveBeenCalledTimes(2);
  const next = new URL(String(fetch.mock.calls[1]?.[0]), 'https://test.invalid');
  expect(JSON.parse(next.searchParams.get('after') ?? '{}')).toEqual(cursor);
});

it('rejects a repeated pagination cursor instead of looping or hiding later proposals', async () => {
  const fetch = vi.fn(
    async () =>
      new Response('[]', {
        headers: {
          'X-Action-Proposals-Next': encodeURIComponent(JSON.stringify({ createdAt: 10, id: 'a' })),
        },
      }),
  );
  await expect(
    new AgentClient({ fetch }).listActionProposals({ threadId: 'thread' }),
  ).rejects.toThrow('cursor');
  expect(fetch).toHaveBeenCalledTimes(2);
});

it('accepts safe integer clocks on either side of the epoch like the proposal store', async () => {
  let page = 0;
  const fetch = vi.fn(async () => {
    page++;
    return new Response('[]', {
      headers:
        page === 1
          ? {
              'X-Action-Proposals-Next': encodeURIComponent(
                JSON.stringify({ createdAt: -1, id: 'first' }),
              ),
            }
          : {},
    });
  });
  expect(await new AgentClient({ fetch }).listActionProposals({ threadId: 'thread' })).toEqual([]);
  expect(fetch).toHaveBeenCalledTimes(2);
});
