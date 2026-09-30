// @vitest-environment jsdom
import type { QuotaReport, StoredMessage, ThreadDetail } from '@dudousxd/nestjs-agent-core';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentBackend, ChatStreamResponse } from './backend.js';
import { QuotaBlockedError, useAgentChat } from './use-agent-chat.js';

const encoder = new TextEncoder();

function sse(frames: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}

function turn(runId: string, threadId: string, text: string): ChatStreamResponse {
  return {
    runId,
    threadId,
    body: sse([
      `event: meta\ndata: {"runId":"${runId}","threadId":"${threadId}"}\n\n`,
      'data: {"kind":"step-start"}\n\n',
      `data: {"kind":"text","text":"${text}"}\n\n`,
      'data: {"kind":"step-finish"}\n\n',
      'event: done\ndata: {}\n\n',
    ]),
  };
}

function row(overrides: Partial<StoredMessage>): StoredMessage {
  return {
    id: 'r',
    role: 'user',
    content: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function detail(id: string, messages: StoredMessage[], extra: Partial<ThreadDetail> = {}) {
  return {
    id,
    title: id,
    transient: false,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    messages,
    activeRunId: null,
    ...extra,
  } as ThreadDetail;
}

function fakeBackend(overrides: Partial<AgentBackend> = {}): AgentBackend {
  return {
    openChatStream: vi.fn(async () => turn('run-1', 'thr-new', 'hello')),
    resumeChatStream: vi.fn(async () => null),
    cancelStream: vi.fn(async () => ({})),
    listThreads: vi.fn(async () => []),
    getThread: vi.fn(async (id: string) => detail(id, [])),
    updateThread: vi.fn(async () => ({ ok: true })),
    deleteThread: vi.fn(async () => undefined),
    approveToolCall: vi.fn(async () => undefined),
    rejectToolCall: vi.fn(async () => undefined),
    ...overrides,
  };
}

const flush = () => act(async () => new Promise((resolve) => setTimeout(resolve, 0)));

describe('useAgentChat — history', () => {
  it('loads a thread’s history by itself when given only a threadId', async () => {
    const backend = fakeBackend({
      getThread: vi.fn(async (id: string) =>
        detail(id, [
          row({ id: 'u1', role: 'user', content: 'hi' }),
          row({ id: 'a1', role: 'assistant', content: 'hello' }),
        ]),
      ),
    });
    const { result } = renderHook(() => useAgentChat({ backend, threadId: 'thr-1' }));
    await waitFor(() => expect(result.current.messages.map((m) => m.id)).toEqual(['u1', 'a1']));
    expect(result.current.isLoadingHistory).toBe(false);
    // Replayed messages carry their time, so the transcript can show it with no getCreatedAt.
    expect(result.current.transcript.items[0]?.timestamp).not.toBeNull();
  });

  it('reports the history as loading from the very first render, so nothing flashes empty', async () => {
    let resolve: (value: ThreadDetail) => void = () => undefined;
    const backend = fakeBackend({
      getThread: vi.fn(
        () =>
          new Promise<ThreadDetail>((done) => {
            resolve = done;
          }),
      ),
    });
    const renders: boolean[] = [];
    const { result, rerender } = renderHook(
      ({ threadId }: { threadId?: string }) => {
        const chat = useAgentChat({ backend, ...(threadId !== undefined ? { threadId } : {}) });
        renders.push(chat.isLoadingHistory);
        return chat;
      },
      { initialProps: { threadId: 'thr-1' } as { threadId?: string } },
    );

    expect(renders[0]).toBe(true);
    await act(async () => resolve(detail('thr-1', [row({ id: 'u1', content: 'hi' })])));
    await waitFor(() => expect(result.current.isLoadingHistory).toBe(false));

    // A switch is loading on its own first render too, before the effect asks for the thread.
    renders.length = 0;
    rerender({ threadId: 'thr-2' });
    expect(renders[0]).toBe(true);
    await act(async () => resolve(detail('thr-2', [])));
    await waitFor(() => expect(result.current.isLoadingHistory).toBe(false));

    // No thread, or history turned off: never loading.
    rerender({});
    expect(result.current.isLoadingHistory).toBe(false);
  });

  it('is not loading when there is no history to read', () => {
    const backend = fakeBackend();
    const off = renderHook(() =>
      useAgentChat({ backend, threadId: 'thr-1', history: false, resume: false }),
    );
    expect(off.result.current.isLoadingHistory).toBe(false);
    const seeded = renderHook(() =>
      useAgentChat({ backend, threadId: 'thr-1', initialMessages: [], resume: false }),
    );
    expect(seeded.result.current.isLoadingHistory).toBe(false);
  });

  it('stops loading when the read fails', async () => {
    const backend = fakeBackend({
      getThread: vi.fn(async () => Promise.reject(new Error('gone'))),
    });
    const { result } = renderHook(() => useAgentChat({ backend, threadId: 'thr-1' }));
    expect(result.current.isLoadingHistory).toBe(true);
    await waitFor(() => expect(result.current.historyError?.message).toBe('gone'));
    expect(result.current.isLoadingHistory).toBe(false);
  });

  it('switching threadId swaps in the other thread’s history', async () => {
    const backend = fakeBackend({
      getThread: vi.fn(async (id: string) =>
        detail(id, [row({ id: `${id}-u`, role: 'user', content: id })]),
      ),
    });
    const { result, rerender } = renderHook(
      ({ threadId }: { threadId: string }) => useAgentChat({ backend, threadId }),
      { initialProps: { threadId: 'a' } },
    );
    await waitFor(() => expect(result.current.messages.map((m) => m.id)).toEqual(['a-u']));
    rerender({ threadId: 'b' });
    await waitFor(() => expect(result.current.messages.map((m) => m.id)).toEqual(['b-u']));
  });

  it('keeps the live conversation when the host adopts the thread it just created', async () => {
    const backend = fakeBackend();
    const { result, rerender } = renderHook(
      ({ threadId }: { threadId?: string }) =>
        useAgentChat({ backend, ...(threadId !== undefined ? { threadId } : {}) }),
      { initialProps: {} as { threadId?: string } },
    );
    await act(async () => {
      await result.current.sendMessage({ text: 'hi' });
    });
    expect(result.current.getThreadId()).toBe('thr-new');
    const before = result.current.messages.map((m) => m.id);
    rerender({ threadId: 'thr-new' });
    await flush();
    expect(result.current.messages.map((m) => m.id)).toEqual(before);
    expect(backend.getThread).not.toHaveBeenCalled();
  });

  it('history: false does not load it', async () => {
    const backend = fakeBackend();
    renderHook(() => useAgentChat({ backend, threadId: 't', history: false, resume: false }));
    await flush();
    expect(backend.getThread).not.toHaveBeenCalled();
  });

  it('leaves the resumed run’s rows to its stream instead of drawing them twice', async () => {
    const backend = fakeBackend({
      getThread: vi.fn(async (id: string) =>
        detail(
          id,
          [
            row({ id: 'u1', role: 'user', content: 'go' }),
            row({ id: 'a1', role: 'assistant', content: 'step one', runId: 'run-live' }),
          ],
          { activeRunId: 'run-live' },
        ),
      ),
      resumeChatStream: vi.fn(async () => turn('run-live', 't', 'step one')),
    });
    const { result } = renderHook(() => useAgentChat({ backend, threadId: 't' }));
    await waitFor(() => expect(backend.resumeChatStream).toHaveBeenCalled());
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    expect(result.current.messages.map((m) => m.role)).toEqual(['user', 'assistant']);
    expect(result.current.messages.map((m) => m.id)).not.toContain('a1');
  });
});

describe('useAgentChat — quota gate', () => {
  const report: QuotaReport = {
    windows: [{ period: 'day', usedTokens: 10, usedUsd: 1, limitUsd: 1 }] as never,
    blocked: { period: 'day', reason: 'Daily budget used up' } as never,
  };

  it('refuses a send when the reported quota blocks, with no option wired', async () => {
    const backend = fakeBackend({ getQuota: vi.fn(async () => report) });
    const { result } = renderHook(() => useAgentChat({ backend }));
    await waitFor(() => expect(result.current.blocked).not.toBeNull());
    await expect(result.current.sendMessage({ text: 'hi' })).rejects.toBeInstanceOf(
      QuotaBlockedError,
    );
    expect(result.current.composer.blockedBy).toBe('quota');
    expect(backend.openChatStream).not.toHaveBeenCalled();
  });

  it('`blocked: null` overrides the report', async () => {
    const backend = fakeBackend({ getQuota: vi.fn(async () => report) });
    const { result } = renderHook(() => useAgentChat({ backend, blocked: null }));
    await waitFor(() => expect(result.current.quota.blocked).not.toBeNull());
    await act(async () => {
      await result.current.sendMessage({ text: 'hi' });
    });
    expect(backend.openChatStream).toHaveBeenCalled();
  });
});

describe('useAgentChat — composer', () => {
  it('sends the draft with the ready files as refs, then clears both', async () => {
    const backend = fakeBackend({
      uploadAttachment: vi.fn(async (file: File) => ({
        mediaId: `m-${file.name}`,
        url: '',
        contentType: file.type,
        name: file.name,
      })),
    });
    const { result } = renderHook(() => useAgentChat({ backend }));
    expect(result.current.composer.blockedBy).toBe('empty');
    act(() => result.current.composer.setText('  look at this  '));
    act(() => result.current.composer.files.add([new File(['x'], 'a.png', { type: 'image/png' })]));
    await waitFor(() => expect(result.current.composer.canSend).toBe(true));
    await act(async () => {
      await result.current.composer.submit();
    });
    const request = vi.mocked(backend.openChatStream).mock.calls[0]?.[0];
    expect(request?.body.message).toBe('look at this');
    expect(request?.body.attachments).toEqual([{ mediaId: 'm-a.png' }]);
    // The sent message shows its files at once, like a reloaded one.
    const sent = result.current.messages.find((message) => message.role === 'user');
    expect(sent?.parts).toContainEqual(
      expect.objectContaining({
        type: 'file',
        filename: 'a.png',
        providerMetadata: { agent: { mediaId: 'm-a.png' } },
      }),
    );
    expect(result.current.composer.text).toBe('');
    expect(result.current.composer.files.items).toHaveLength(0);
  });

  it('holds the send while a file is still uploading', async () => {
    const backend = fakeBackend({ uploadAttachment: vi.fn(() => new Promise<never>(() => {})) });
    const { result } = renderHook(() => useAgentChat({ backend }));
    act(() => result.current.composer.setText('hi'));
    act(() => result.current.composer.files.add([new File(['x'], 'a.png', { type: 'image/png' })]));
    expect(result.current.composer.blockedBy).toBe('uploading');
    await act(async () => {
      await result.current.composer.submit();
    });
    expect(backend.openChatStream).not.toHaveBeenCalled();
  });
});

describe('useAgentChat — transcript', () => {
  it('binds approve to the chat, so a parked call is actionable with no wiring', async () => {
    const backend = fakeBackend({
      getThread: vi.fn(async (id: string) =>
        detail(id, [
          row({ id: 'u1', role: 'user', content: 'delete it' }),
          row({
            id: 'a1',
            role: 'assistant',
            content: '',
            toolCalls: [{ id: 'call-1', name: 'deleteUser', input: { id: 1 }, kind: 'action' }],
          } as Partial<StoredMessage>),
        ]),
      ),
    });
    const { result } = renderHook(() => useAgentChat({ backend, threadId: 't', resume: false }));
    await waitFor(() => expect(result.current.transcript.items).toHaveLength(2));
    const block = result.current.transcript.items[1]?.blocks.find((b) => b.kind === 'tools');
    const call = block?.kind === 'tools' ? block.calls[0] : undefined;
    expect(call?.approve.available).toBe(true);
    act(() => call?.approve.run());
    await waitFor(() =>
      expect(backend.approveToolCall).toHaveBeenCalledWith({ toolCallId: 'call-1' }),
    );
    expect(result.current.transcript.stop.available).toBe(false);
  });
});

describe('useAgentChat — agent', () => {
  it('sends the agent picked at send time, not the one the chat mounted with', async () => {
    const backend = fakeBackend();
    const { result, rerender } = renderHook(
      ({ agent }: { agent: string }) => useAgentChat({ backend, agent }),
      { initialProps: { agent: 'first' } },
    );
    rerender({ agent: 'second' });
    await act(async () => {
      await result.current.sendMessage({ text: 'hi' });
    });
    expect(backend.openChatStream).toHaveBeenCalledWith(
      expect.objectContaining({ body: expect.objectContaining({ agent: 'second' }) }),
    );
  });
});
