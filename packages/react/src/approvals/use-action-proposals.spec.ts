import type { ActionProposal, StoredMessage } from '@dudousxd/nestjs-agent-core';
// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentBackend } from '../backend.js';
import { AgentClient } from '../client.js';
import { useActionProposals } from './use-action-proposals.js';

const pending = {
  id: 'p',
  threadId: 't',
  originToolCallId: 'c',
  decision: 'pending',
  execution: null,
} as ActionProposal;
afterEach(() => vi.useRealTimers());
it('polls after origin SSE ends, reconciles admitted UI during another active turn, and refetches on focus/reconnect', async () => {
  vi.useFakeTimers();
  let rows = [pending];
  let messages: UIMessage[] = [
    { id: 'active', role: 'assistant', parts: [{ type: 'text', text: 'live answer' }] },
  ];
  const fact = {
    id: 'fact',
    role: 'assistant',
    content: 'Done',
    actionProposalOutcome: { id: 'outcome' },
    ui: [{ id: 'card', component: 'Text', props: {} }],
  } as unknown as StoredMessage;
  const list = vi.fn(async () => rows);
  const backend = {
    listActionProposals: list,
    getThread: async () => ({ messages: [fact] }),
  } as unknown as AgentBackend;
  const setMessages = (update: (current: UIMessage[]) => UIMessage[]) => {
    messages = update(messages);
  };
  const { result } = renderHook(() => useActionProposals(backend, 't', setMessages, 'ready', 100));
  await act(async () => {
    await result.current.refresh();
  });
  expect(result.current.items).toEqual([pending]);
  rows = [
    {
      ...pending,
      decision: 'approved',
      execution: { status: 'succeeded', generation: 1, lease: null },
      outcomeDelivery: { status: 'admitted', generation: 1, lease: null, messageId: 'fact' },
    },
  ];
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  expect(messages.map((message) => message.id)).toEqual(['active', 'fact']);
  expect(messages[0]?.parts).toEqual([{ type: 'text', text: 'live answer' }]);
  expect(messages[1]?.parts.some((part) => part.type === 'data-ui')).toBe(true);
  await act(async () => {
    window.dispatchEvent(new Event('focus'));
    await result.current.refresh();
  });
  await act(async () => {
    window.dispatchEvent(new Event('online'));
    await result.current.refresh();
  });
  expect(messages).toHaveLength(2);
  expect(list).toHaveBeenCalledTimes(4);
});
it('drops replies belonging to a thread that was switched while the request was pending', async () => {
  let resolve!: (rows: ActionProposal[]) => void;
  const backend = {
    listActionProposals: ({ threadId }: { threadId: string }) =>
      threadId === 'old'
        ? new Promise<ActionProposal[]>((done) => {
            resolve = done;
          })
        : Promise.resolve([]),
  } as unknown as AgentBackend;
  const setMessages = vi.fn();
  const { result, rerender } = renderHook(
    ({ threadId }) => useActionProposals(backend, threadId, setMessages, 'ready'),
    { initialProps: { threadId: 'old' } },
  );
  rerender({ threadId: 'new' });
  await act(async () => {
    resolve([pending]);
  });
  await waitFor(() => expect(result.current.items).toEqual([]));
  expect(setMessages).toHaveBeenCalledTimes(1);
});

function httpError(status: number, message = `Agent request failed → ${status}`) {
  return Object.assign(new Error(message), { status });
}

it.each([404, 405, 501])(
  'treats a %i from the proposals route as unsupported: no more reads, no polling, no error',
  async (status) => {
    vi.useFakeTimers();
    const list = vi.fn(async () => {
      throw httpError(status);
    });
    const backend = { listActionProposals: list } as unknown as AgentBackend;
    const { result, rerender } = renderHook(
      ({ key }) => useActionProposals(backend, 't', vi.fn(), key, 100),
      { initialProps: { key: 'ready:open' } },
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(list).toHaveBeenCalledTimes(1);
    expect(result.current.unsupported).toBe(true);
    expect(result.current.error).toBeNull();
    // Nothing asks again: not time, not the stream's status, not focus, not a manual refresh.
    rerender({ key: 'streaming:open' });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      window.dispatchEvent(new Event('online'));
      await result.current.refresh();
      await vi.advanceTimersByTimeAsync(10_000);
    });
    expect(list).toHaveBeenCalledTimes(1);
    // Another chat over the same backend (session) does not ask either.
    const other = renderHook(() => useActionProposals(backend, 'u', vi.fn(), 'ready', 100));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1000);
    });
    expect(other.result.current.unsupported).toBe(true);
    expect(list).toHaveBeenCalledTimes(1);
  },
);

it("keeps reading a thread the route does not know yet (it is not 'unsupported')", async () => {
  const list = vi.fn(async () => {
    throw httpError(404, 'Thread not found');
  });
  const backend = { listActionProposals: list } as unknown as AgentBackend;
  const { result } = renderHook(() => useActionProposals(backend, 't', vi.fn(), 'ready', 100));
  await waitFor(() => expect(result.current.error?.message).toBe('Thread not found'));
  expect(result.current.unsupported).toBe(false);
  await act(async () => {
    await result.current.refresh();
  });
  expect(list).toHaveBeenCalledTimes(2);
});

it('backs off while transient errors interrupt polling, and resumes the pace on success', async () => {
  vi.useFakeTimers();
  let failing = false;
  const list = vi.fn(async () => {
    if (failing) throw httpError(503);
    return [pending];
  });
  const backend = { listActionProposals: list } as unknown as AgentBackend;
  const { result } = renderHook(() => useActionProposals(backend, 't', vi.fn(), 'ready', 100));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  expect(list).toHaveBeenCalledTimes(1);
  failing = true;
  // Poll at 100 ms fails; the next waits 200, then 400, then 800.
  const callsAt = async (ms: number) => {
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
    return list.mock.calls.length;
  };
  expect(await callsAt(100)).toBe(2);
  expect(await callsAt(199)).toBe(2);
  expect(await callsAt(1)).toBe(3);
  expect(await callsAt(399)).toBe(3);
  expect(await callsAt(1)).toBe(4);
  expect(result.current.error).not.toBeNull();
  expect(result.current.unsupported).toBe(false);
  failing = false;
  expect(await callsAt(800)).toBe(5);
  expect(result.current.error).toBeNull();
  expect(await callsAt(100)).toBe(6);
});

it("stops after the real client's first 404 from a server that mounts no proposals route", async () => {
  vi.useFakeTimers();
  const onHttpError = vi.fn();
  const fetch = vi.fn(
    async () =>
      new Response(
        JSON.stringify({
          message: 'Cannot GET /agent/threads/t/action-proposals',
          error: 'Not Found',
          statusCode: 404,
        }),
        { status: 404, headers: { 'content-type': 'application/json' } },
      ),
  );
  const client = new AgentClient({ fetch, onHttpError });
  const { result, rerender } = renderHook(
    ({ key }) => useActionProposals(client, 't', vi.fn(), key, 1000),
    { initialProps: { key: 'ready:open' } },
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(0);
  });
  for (const key of ['submitted:open', 'streaming:open', 'ready:open']) {
    rerender({ key });
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(1000);
    });
  }
  expect(result.current.unsupported).toBe(true);
  expect(fetch).toHaveBeenCalledTimes(1);
  // Told once — a listener that logs logs once.
  expect(onHttpError).toHaveBeenCalledTimes(1);
});
