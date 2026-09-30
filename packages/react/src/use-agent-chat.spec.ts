// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { AgentClient } from './client.js';
import { useAgentChat } from './use-agent-chat.js';

function sseResponse(frames: string[]): Response {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return new Response(body, { status: 200, statusText: 'OK' });
}

/** A 200 carrying `body` as JSON; with no body, the empty 200 the client reads as `undefined`. */
function jsonResponse(body?: unknown): Response {
  return new Response(body === undefined ? '' : JSON.stringify(body), {
    status: 200,
    statusText: 'OK',
  });
}

describe('useAgentChat', () => {
  it('streams assistant text and approves a tool call against the live run', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
      const url = String(input);
      calls.push({ url, ...(init ? { init } : {}) });
      if (url.endsWith('/agent/chat')) {
        return sseResponse([
          'event: meta\ndata: {"runId":"run-1","threadId":"thr-1"}\n\n',
          'data: {"kind":"step-start"}\n\n',
          'data: {"kind":"text","text":"Hello"}\n\n',
          'data: {"kind":"text","text":" world"}\n\n',
          'data: {"kind":"step-finish"}\n\n',
          'event: done\ndata: {}\n\n',
        ]);
      }
      return jsonResponse();
    });

    const { result } = renderHook(() =>
      useAgentChat({
        threadId: 'thr-1',
        backend: new AgentClient({ fetch: fetchMock }),
      }),
    );

    await act(async () => {
      await result.current.sendMessage({ text: 'hi' });
    });

    await waitFor(() => {
      const last = result.current.messages.at(-1);
      expect(last?.role).toBe('assistant');
      const text = (last?.parts ?? [])
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('');
      expect(text).toBe('Hello world');
    });

    // runId surfaces from the meta frame (for cancel / resume); HITL routes by tool-call id alone.
    await waitFor(() => expect(result.current.runId).toBe('run-1'));

    await act(async () => {
      await result.current.approve({ toolCallId: 'tc-1' });
    });

    const approveCall = calls.find((call) => call.url.endsWith('/agent/tool-call/approve'));
    expect(approveCall).toBeDefined();
    expect(JSON.parse(String(approveCall?.init?.body))).toEqual({ toolCallId: 'tc-1' });
  });

  it('sends only the latest user message text in the chat request body', async () => {
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      if (String(input).endsWith('/agent/chat')) {
        return sseResponse(['data: {"kind":"text","text":"ok"}\n\n', 'event: done\ndata: {}\n\n']);
      }
      return jsonResponse();
    });

    const { result } = renderHook(() =>
      useAgentChat({
        threadId: 'thr-9',
        backend: new AgentClient({ fetch: fetchMock }),
      }),
    );

    await act(async () => {
      await result.current.sendMessage({ text: 'how many users?' });
    });

    const chatCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/agent/chat'));
    expect(chatCall).toBeDefined();
    const body = JSON.parse(String(chatCall?.[1]?.body));
    expect(body).toMatchObject({
      message: 'how many users?',
      threadId: 'thr-9',
    });
  });

  it('reuses the backend-created thread on later sends (no new thread per message)', async () => {
    const created: string[] = [];
    const fetchMock = vi.fn<typeof fetch>(async (input) => {
      const url = String(input);
      if (url.endsWith('/agent/chat')) {
        return sseResponse([
          'event: meta\ndata: {"runId":"run-1","threadId":"srv-thread"}\n\n',
          'data: {"kind":"text","text":"hi"}\n\n',
          'event: done\ndata: {}\n\n',
        ]);
      }
      return jsonResponse();
    });

    // No threadId option → a "new chat". The backend mints `srv-thread` and reports it via `meta`.
    const { result } = renderHook(() =>
      useAgentChat({
        backend: new AgentClient({ fetch: fetchMock }),
        onThreadCreated: (id) => created.push(id),
      }),
    );

    await act(async () => {
      await result.current.sendMessage({ text: 'first' });
    });
    await act(async () => {
      await result.current.sendMessage({ text: 'second' });
    });

    const chatBodies = fetchMock.mock.calls
      .filter(([url]) => String(url).endsWith('/agent/chat'))
      .map(([, init]) => JSON.parse(String(init?.body)));

    // First send carries no threadId (none exists yet); the second reuses the created one.
    expect(chatBodies[0]).toMatchObject({ message: 'first' });
    expect(chatBodies[0].threadId).toBeUndefined();
    expect(chatBodies[1]).toMatchObject({ message: 'second', threadId: 'srv-thread' });
    // onThreadCreated fires exactly once, with the server id.
    expect(created).toEqual(['srv-thread']);
  });

  describe('resume', () => {
    it('fetches the thread on mount and attaches to its active run', async () => {
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url.endsWith('/agent/threads/thr-1')) {
          return jsonResponse({
            id: 'thr-1',
            title: 'Resumed thread',
            transient: false,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            messages: [],
            activeRunId: 'run-live',
          });
        }
        if (url.endsWith('/agent/chat/run-live/stream')) {
          return sseResponse([
            'event: meta\ndata: {"runId":"run-live","threadId":"thr-1"}\n\n',
            'data: {"kind":"step-start"}\n\n',
            'data: {"kind":"text","text":"still going"}\n\n',
            'data: {"kind":"step-finish"}\n\n',
            'event: done\ndata: {}\n\n',
          ]);
        }
        return jsonResponse();
      });

      const { result } = renderHook(() =>
        useAgentChat({
          threadId: 'thr-1',
          resume: true,
          backend: new AgentClient({ fetch: fetchMock }),
        }),
      );

      await waitFor(() => expect(result.current.activeRunId).toBe('run-live'));

      await waitFor(() => {
        const last = result.current.messages.at(-1);
        expect(last?.role).toBe('assistant');
        const text = (last?.parts ?? [])
          .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
          .map((part) => part.text)
          .join('');
        expect(text).toBe('still going');
      });

      expect(
        fetchMock.mock.calls.some(([url]) => String(url).endsWith('/agent/threads/thr-1')),
      ).toBe(true);
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).endsWith('/agent/chat/run-live/stream')),
      ).toBe(true);
    });

    /**
     * A stream attached to after a reload opens with no `meta` frame — the run id is known only from
     * the thread read. Stop has to cancel THAT run: with no id the client closed nothing and asked
     * the server for nothing, and the answer kept streaming under a Stop button that did nothing.
     */
    it('cancels the run it re-attached to, which no meta frame ever named', async () => {
      const encoder = new TextEncoder();
      let release: (() => void) | undefined;
      const fetchMock = vi.fn<typeof fetch>(async (input, init) => {
        const url = String(input);
        if (url.endsWith('/agent/threads/thr-1')) {
          return jsonResponse({
            id: 'thr-1',
            title: 'Resumed thread',
            transient: false,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            messages: [],
            activeRunId: 'run-live',
          });
        }
        if (url.endsWith('/agent/chat/run-live/stream')) {
          // Open until the run is cancelled, the way a live run's stream is.
          const body = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(encoder.encode('id: 1\ndata: {"kind":"step-start"}\n\n'));
              controller.enqueue(
                encoder.encode('id: 2\ndata: {"kind":"text","text":"still going"}\n\n'),
              );
              release = () => {
                controller.enqueue(encoder.encode('event: done\ndata: {}\n\n'));
                controller.close();
              };
            },
          });
          return new Response(body, { status: 200, statusText: 'OK' });
        }
        if (url.endsWith('/agent/chat/run-live/cancel') && init?.method === 'POST') {
          release?.();
          return jsonResponse({ aborted: true });
        }
        return jsonResponse();
      });
      const settled: string[] = [];

      const { result } = renderHook(() =>
        useAgentChat({
          threadId: 'thr-1',
          resume: true,
          backend: new AgentClient({ fetch: fetchMock }),
          onRunSettled: ({ runId }) => settled.push(runId),
        }),
      );

      await waitFor(() => expect(result.current.runId).toBe('run-live'));

      await act(async () => {
        await result.current.cancel();
      });

      expect(
        fetchMock.mock.calls.some(
          ([url, init]) =>
            String(url).endsWith('/agent/chat/run-live/cancel') && init?.method === 'POST',
        ),
      ).toBe(true);
      // The re-attached run settles like one this chat started: its host refreshes on it.
      await waitFor(() => expect(settled).toEqual(['run-live']));
    });

    it('does not attach to a stream when the thread has no active run', async () => {
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url.endsWith('/agent/threads/thr-2')) {
          return jsonResponse({
            id: 'thr-2',
            title: 'Idle thread',
            transient: false,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            messages: [],
            activeRunId: null,
          });
        }
        return jsonResponse();
      });

      const { result } = renderHook(() =>
        useAgentChat({
          threadId: 'thr-2',
          resume: true,
          backend: new AgentClient({ fetch: fetchMock }),
        }),
      );

      await waitFor(() =>
        expect(
          fetchMock.mock.calls.some(([url]) => String(url).endsWith('/agent/threads/thr-2')),
        ).toBe(true),
      );
      expect(result.current.activeRunId).toBeNull();
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/stream'))).toBe(false);
    });

    it('never fetches the thread with history and resume both off', async () => {
      const fetchMock = vi.fn<typeof fetch>(async () => jsonResponse());

      renderHook(() =>
        useAgentChat({
          threadId: 'thr-3',
          history: false,
          resume: false,
          backend: new AgentClient({ fetch: fetchMock }),
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetchMock.mock.calls.some(([url]) => String(url).includes('/threads/'))).toBe(false);
    });

    it('resumes by default — no option needed', async () => {
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url.endsWith('/agent/threads/thr-4')) {
          return jsonResponse({
            id: 'thr-4',
            title: 't',
            transient: false,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            messages: [],
            activeRunId: 'run-4',
          });
        }
        if (url.endsWith('/agent/chat/run-4/stream')) {
          return sseResponse([
            'event: meta\ndata: {"runId":"run-4","threadId":"thr-4"}\n\n',
            'data: {"kind":"step-start"}\n\n',
            'data: {"kind":"text","text":"resumed"}\n\n',
            'data: {"kind":"step-finish"}\n\n',
            'event: done\ndata: {}\n\n',
          ]);
        }
        return jsonResponse();
      });
      const { result } = renderHook(() =>
        useAgentChat({ threadId: 'thr-4', backend: new AgentClient({ fetch: fetchMock }) }),
      );
      await waitFor(() => expect(result.current.messages.at(-1)?.role).toBe('assistant'));
      expect(
        fetchMock.mock.calls.some(([url]) => String(url).endsWith('/agent/chat/run-4/stream')),
      ).toBe(true);
    });
  });

  describe('onRunSettled', () => {
    it('fires once with status "completed" when the stream ends on a normal `done` frame', async () => {
      const settled: Array<{ runId: string; status: 'completed' | 'failed' }> = [];
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url.endsWith('/agent/chat')) {
          return sseResponse([
            'event: meta\ndata: {"runId":"run-1","threadId":"thr-1"}\n\n',
            'data: {"kind":"text","text":"hi"}\n\n',
            'event: done\ndata: {}\n\n',
          ]);
        }
        return jsonResponse();
      });

      const { result } = renderHook(() =>
        useAgentChat({
          threadId: 'thr-1',
          backend: new AgentClient({ fetch: fetchMock }),
          onRunSettled: (outcome) => settled.push(outcome),
        }),
      );

      await act(async () => {
        await result.current.sendMessage({ text: 'hi' });
      });

      await waitFor(() => expect(settled).toEqual([{ runId: 'run-1', status: 'completed' }]));
    });

    it('fires once with status "failed" when the stream ends on an `event: error` frame', async () => {
      const settled: Array<{ runId: string; status: 'completed' | 'failed' }> = [];
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url.endsWith('/agent/chat')) {
          return sseResponse([
            'event: meta\ndata: {"runId":"run-2","threadId":"thr-2"}\n\n',
            'data: {"kind":"text","text":"partial"}\n\n',
            'event: error\ndata: {"code":"boom","message":"model unavailable"}\n\n',
          ]);
        }
        return jsonResponse();
      });

      const { result } = renderHook(() =>
        useAgentChat({
          threadId: 'thr-2',
          backend: new AgentClient({ fetch: fetchMock }),
          onRunSettled: (outcome) => settled.push(outcome),
        }),
      );

      await act(async () => {
        await result.current.sendMessage({ text: 'hi' }).catch(() => undefined);
      });

      await waitFor(() => expect(settled).toEqual([{ runId: 'run-2', status: 'failed' }]));
    });

    it('is not called again per additional send beyond the one fired for that turn', async () => {
      const settled: Array<{ runId: string; status: 'completed' | 'failed' }> = [];
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url.endsWith('/agent/chat')) {
          return sseResponse([
            'event: meta\ndata: {"runId":"run-3","threadId":"thr-3"}\n\n',
            'data: {"kind":"text","text":"ok"}\n\n',
            'event: done\ndata: {}\n\n',
          ]);
        }
        return jsonResponse();
      });

      const { result } = renderHook(() =>
        useAgentChat({
          threadId: 'thr-3',
          backend: new AgentClient({ fetch: fetchMock }),
          onRunSettled: (outcome) => settled.push(outcome),
        }),
      );

      await act(async () => {
        await result.current.sendMessage({ text: 'hi' });
      });

      await waitFor(() => expect(settled).toHaveLength(1));
      expect(settled).toEqual([{ runId: 'run-3', status: 'completed' }]);
    });

    it('fires on a resumed stream reaching its own `done` frame', async () => {
      const settled: Array<{ runId: string; status: 'completed' | 'failed' }> = [];
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url.endsWith('/agent/threads/thr-4')) {
          return jsonResponse({
            id: 'thr-4',
            title: 'Resumed thread',
            transient: false,
            createdAt: '2026-01-01T00:00:00.000Z',
            updatedAt: '2026-01-01T00:00:00.000Z',
            messages: [],
            activeRunId: 'run-resumed',
          });
        }
        if (url.endsWith('/agent/chat/run-resumed/stream')) {
          return sseResponse([
            'event: meta\ndata: {"runId":"run-resumed","threadId":"thr-4"}\n\n',
            'data: {"kind":"text","text":"still going"}\n\n',
            'event: done\ndata: {}\n\n',
          ]);
        }
        return jsonResponse();
      });

      renderHook(() =>
        useAgentChat({
          threadId: 'thr-4',
          resume: true,
          backend: new AgentClient({ fetch: fetchMock }),
          onRunSettled: (outcome) => settled.push(outcome),
        }),
      );

      await waitFor(() => expect(settled).toEqual([{ runId: 'run-resumed', status: 'completed' }]));
    });

    it('does not fire when the attempt fails before any run id was ever learned', async () => {
      const settled: Array<{ runId: string; status: 'completed' | 'failed' }> = [];
      const fetchMock = vi.fn<typeof fetch>(async (input) => {
        const url = String(input);
        if (url.endsWith('/agent/chat')) {
          return new Response(null, { status: 500, statusText: 'Internal Server Error' });
        }
        return jsonResponse();
      });

      const { result } = renderHook(() =>
        useAgentChat({
          threadId: 'thr-5',
          backend: new AgentClient({ fetch: fetchMock }),
          onRunSettled: (outcome) => settled.push(outcome),
        }),
      );

      await act(async () => {
        await result.current.sendMessage({ text: 'hi' }).catch(() => undefined);
      });

      await waitFor(() => expect(result.current.error).toBeDefined());
      expect(settled).toEqual([]);
    });
  });
});
