// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAgentChat } from './use-agent-chat.js';

function sseResponse(frames: string[]) {
  const encoder = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    body,
    headers: new Headers(),
  };
}

function jsonResponse() {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers(),
    text: async () => '',
  };
}

describe('useAgentChat', () => {
  it('streams assistant text and approves a tool call against the live run', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
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
        fetch: fetchMock as unknown as typeof fetch,
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
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/agent/chat')) {
        return sseResponse(['data: {"kind":"text","text":"ok"}\n\n', 'event: done\ndata: {}\n\n']);
      }
      return jsonResponse();
    });

    const { result } = renderHook(() =>
      useAgentChat({
        threadId: 'thr-9',
        fetch: fetchMock as unknown as typeof fetch,
      }),
    );

    await act(async () => {
      await result.current.sendMessage({ text: 'how many users?' });
    });

    const chatCall = fetchMock.mock.calls.find(([url]) => String(url).endsWith('/agent/chat'));
    expect(chatCall).toBeDefined();
    const body = JSON.parse(String((chatCall?.[1] as RequestInit).body));
    expect(body).toMatchObject({
      message: 'how many users?',
      threadId: 'thr-9',
    });
  });

  it('reuses the backend-created thread on later sends (no new thread per message)', async () => {
    const created: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
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
        fetch: fetchMock as unknown as typeof fetch,
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
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)));

    // First send carries no threadId (none exists yet); the second reuses the created one.
    expect(chatBodies[0]).toMatchObject({ message: 'first' });
    expect(chatBodies[0].threadId).toBeUndefined();
    expect(chatBodies[1]).toMatchObject({ message: 'second', threadId: 'srv-thread' });
    // onThreadCreated fires exactly once, with the server id.
    expect(created).toEqual(['srv-thread']);
  });

  describe('resume', () => {
    it('fetches the thread on mount and attaches to its active run', async () => {
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith('/agent/threads/thr-1')) {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
            text: async () =>
              JSON.stringify({
                id: 'thr-1',
                title: 'Resumed thread',
                transient: false,
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
                messages: [],
                activeRunId: 'run-live',
              }),
          };
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
          fetch: fetchMock as unknown as typeof fetch,
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

    it('does not attach to a stream when the thread has no active run', async () => {
      const fetchMock = vi.fn(async (url: string) => {
        if (url.endsWith('/agent/threads/thr-2')) {
          return {
            ok: true,
            status: 200,
            statusText: 'OK',
            headers: new Headers(),
            text: async () =>
              JSON.stringify({
                id: 'thr-2',
                title: 'Idle thread',
                transient: false,
                createdAt: '2026-01-01T00:00:00.000Z',
                updatedAt: '2026-01-01T00:00:00.000Z',
                messages: [],
                activeRunId: null,
              }),
          };
        }
        return jsonResponse();
      });

      const { result } = renderHook(() =>
        useAgentChat({
          threadId: 'thr-2',
          resume: true,
          fetch: fetchMock as unknown as typeof fetch,
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

    it('never fetches the thread when resume is not set (default false)', async () => {
      const fetchMock = vi.fn(async () => jsonResponse());

      renderHook(() =>
        useAgentChat({ threadId: 'thr-3', fetch: fetchMock as unknown as typeof fetch }),
      );

      await new Promise((resolve) => setTimeout(resolve, 0));
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });
});
