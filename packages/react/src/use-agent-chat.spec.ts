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
          'data: {"delta":"Hello"}\n\n',
          'data: {"delta":" world"}\n\n',
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

    // runId surfaced from the meta frame drives HITL targeting.
    await waitFor(() => expect(result.current.runId).toBe('run-1'));

    await act(async () => {
      await result.current.approve({ toolCallId: 'tc-1' });
    });

    const approveCall = calls.find((call) => call.url.endsWith('/agent/tool-call/approve'));
    expect(approveCall).toBeDefined();
    expect(JSON.parse(String(approveCall?.init?.body))).toEqual({
      runId: 'run-1',
      toolCallId: 'tc-1',
    });
  });

  it('sends only the latest user message text in the chat request body', async () => {
    const fetchMock = vi.fn(async (url: string) => {
      if (url.endsWith('/agent/chat')) {
        return sseResponse(['data: {"delta":"ok"}\n\n', 'event: done\ndata: {}\n\n']);
      }
      return jsonResponse();
    });

    const { result } = renderHook(() =>
      useAgentChat({
        threadId: 'thr-9',
        persona: 'default',
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
      persona: 'default',
    });
  });
});
