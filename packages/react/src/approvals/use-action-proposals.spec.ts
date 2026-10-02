import type { ActionProposal, StoredMessage } from '@dudousxd/nestjs-agent-core';
// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import type { UIMessage } from 'ai';
import { afterEach, expect, it, vi } from 'vitest';
import type { AgentBackend } from '../backend.js';
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
