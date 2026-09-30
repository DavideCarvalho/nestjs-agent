// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentBackend } from './backend.js';
import { useAgentChat } from './use-agent-chat.js';

const encoder = new TextEncoder();

function answer(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(
        encoder.encode('event: meta\ndata: {"runId":"run-1","threadId":"thr-1"}\n\n'),
      );
      controller.enqueue(
        encoder.encode(`id: 1\ndata: ${JSON.stringify({ kind: 'text', text })}\n\n`),
      );
      controller.enqueue(encoder.encode('event: done\ndata: {}\n\n'));
      controller.close();
    },
  });
}

describe('useAgentChat — regenerate', () => {
  it('asks for `regenerate: true` on the same thread and keeps the one user message', async () => {
    const answers = ['first answer', 'second answer'];
    const openChatStream = vi.fn(async () => ({
      body: answer(answers.shift() ?? ''),
      runId: 'run-1',
      threadId: 'thr-1',
    }));
    const backend: AgentBackend = {
      openChatStream,
      resumeChatStream: async () => null,
      cancelStream: async () => ({}),
      listThreads: async () => [],
      getThread: async () => {
        throw new Error('unused');
      },
      updateThread: async () => ({}),
      deleteThread: async () => undefined,
    };
    const { result } = renderHook(() => useAgentChat({ backend, quota: false }));

    await act(async () => {
      await result.current.sendMessage({ text: 'hello' });
    });
    act(() => result.current.regenerate());
    await waitFor(() => expect(openChatStream).toHaveBeenCalledTimes(2));
    await waitFor(() => expect(result.current.status).toBe('ready'));

    const [, second] = openChatStream.mock.calls.map((call) => (call as unknown[])[0]);
    expect((second as { body: Record<string, unknown> }).body).toMatchObject({
      regenerate: true,
      threadId: 'thr-1',
    });
    expect(result.current.messages.map((message) => message.role)).toEqual(['user', 'assistant']);
    const last = result.current.messages.at(-1);
    expect(last?.parts.some((part) => part.type === 'text' && part.text === 'second answer')).toBe(
      true,
    );
  });
});
