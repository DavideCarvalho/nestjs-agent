// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import { useChatTranscript } from './transcript/use-chat-transcript.js';
import { type UseAgentChatOptions, useAgentChat } from './use-agent-chat.js';

/** The frames a settled turn replays — identical on a POST and on a resume GET of the same run. */
const TURN = [
  'event: meta\ndata: {"runId":"run-1","threadId":"thr-1"}\n\n',
  'data: {"kind":"step-start"}\n\n',
  'data: {"kind":"text","text":"Hel"}\n\n',
  'data: {"kind":"text","text":"lo"}\n\n',
  'data: {"kind":"step-finish"}\n\n',
  'event: done\ndata: {}\n\n',
];

function sseResponse(frames: string[]) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return { ok: true, status: 200, statusText: 'OK', body, headers: new Headers() };
}

/** Every attempt gets its own copy of the same buffered run, the way the backend replays one. */
function streamingFetch() {
  return vi.fn(async (_url: string) => sseResponse(TURN));
}

/** Drain the stream readers, which settle on the macrotask queue rather than in a microtask. */
async function drain(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

function renderTranscript(options: UseAgentChatOptions, strict = false) {
  return renderHook(
    () => {
      const chat = useAgentChat(options);
      const transcript = useChatTranscript({ messages: chat.messages, status: chat.status });
      return { chat, transcript };
    },
    strict ? { wrapper: StrictMode } : {},
  );
}

function urlsMatching(fetchMock: ReturnType<typeof streamingFetch>, fragment: string): string[] {
  return fetchMock.mock.calls.map(([url]) => String(url)).filter((url) => url.includes(fragment));
}

describe('transcript identity', () => {
  it('keeps item ids unique when StrictMode runs the resume effect twice', async () => {
    const fetchMock = streamingFetch();
    const { result } = renderTranscript(
      {
        threadId: 'thr-1',
        resumeRunId: 'run-1',
        fetch: fetchMock as unknown as typeof fetch,
      },
      true,
    );

    await waitFor(() => expect(result.current.transcript.items.length).toBeGreaterThan(0));
    await drain();

    const ids = result.current.transcript.items.map((item) => item.id);
    expect(ids).toEqual([...new Set(ids)]);
    // One attachment per run: a second GET replays the same buffered frames into the same list.
    expect(urlsMatching(fetchMock, '/stream')).toHaveLength(1);
  });

  it('keeps item ids unique when a settled turn is then resumed', async () => {
    const fetchMock = streamingFetch();
    const { result } = renderTranscript({
      threadId: 'thr-1',
      resumeRunId: 'run-1',
      fetch: fetchMock as unknown as typeof fetch,
    });

    await act(async () => {
      await result.current.chat.sendMessage({ text: 'hi' });
    });
    await drain();

    await act(async () => {
      await result.current.chat.resumeStream();
    });
    await drain();

    const ids = result.current.transcript.items.map((item) => item.id);
    expect(ids).toEqual([...new Set(ids)]);
  });

  it('keeps item ids unique when a second send races the turn in flight', async () => {
    const fetchMock = streamingFetch();
    const { result } = renderTranscript({
      threadId: 'thr-1',
      fetch: fetchMock as unknown as typeof fetch,
    });

    await act(async () => {
      void result.current.chat.sendMessage({ text: 'first' });
      void result.current.chat.sendMessage({ text: 'second' });
      await new Promise((resolve) => setTimeout(resolve, 30));
    });
    await drain();

    const ids = result.current.transcript.items.map((item) => item.id);
    expect(ids).toEqual([...new Set(ids)]);
    expect(urlsMatching(fetchMock, '/agent/chat')).toHaveLength(1);
  });

  it('accepts the next send once the turn it raced has settled', async () => {
    const fetchMock = streamingFetch();
    const { result } = renderTranscript({
      threadId: 'thr-1',
      fetch: fetchMock as unknown as typeof fetch,
    });

    await act(async () => {
      await result.current.chat.sendMessage({ text: 'first' });
    });
    await drain();
    await act(async () => {
      await result.current.chat.sendMessage({ text: 'second' });
    });
    await drain();

    expect(urlsMatching(fetchMock, '/agent/chat')).toHaveLength(2);
    const ids = result.current.transcript.items.map((item) => item.id);
    expect(ids).toEqual([...new Set(ids)]);
    expect(result.current.transcript.items).toHaveLength(4);
  });
});
