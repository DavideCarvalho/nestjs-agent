// @vitest-environment jsdom
// Typing ahead: a message sent while a turn is running waits in the thread's (server-side) queue,
// and the chat attaches to the turn it becomes once the running one settles.
import type { ChatQueueState, QueuedMessageView, ThreadDetail } from '@dudousxd/nestjs-agent-core';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { messageFiles } from './attachments/files.js';
import type {
  AgentBackend,
  ChatStreamRequest,
  ChatStreamResponse,
  QueuedMessageUpdate,
  QueuedSendResult,
  ResumeStreamRequest,
} from './backend.js';
import { useAgentChat } from './use-agent-chat.js';

const encoder = new TextEncoder();

/** An SSE body that writes `head`, waits for `gate`, then writes `tail`. */
function gatedStream(head: string[], gate: Promise<void>, tail: string[]) {
  const frames = [...head];
  let waited = false;
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      let next = frames.shift();
      if (next === undefined && !waited) {
        waited = true;
        await gate;
        frames.push(...tail);
        next = frames.shift();
      }
      if (next === undefined) controller.close();
      else controller.enqueue(encoder.encode(next));
    },
  });
}

function sse(frames: string[]) {
  return gatedStream(frames, Promise.resolve(), []);
}

const meta = (runId: string) =>
  `event: meta\ndata: ${JSON.stringify({ runId, threadId: 'thr-1' })}\n\n`;
let seq = 0;
const frame = (event: object) => {
  seq += 1;
  return `id: ${seq}\ndata: ${JSON.stringify(event)}\n\n`;
};
const DONE = 'event: done\ndata: {}\n\n';
const text = (value: string) => frame({ kind: 'text', text: value });

function view(id: string, content: string, extra: Partial<QueuedMessageView> = {}) {
  return { id, content, createdAt: 'x', updatedAt: 'x', ...extra };
}

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

interface QueueBackend extends AgentBackend {
  enqueued: ChatStreamRequest[];
  resumed: ResumeStreamRequest[];
  updates: Array<{ id: string; update: QueuedMessageUpdate }>;
  interrupted: string[];
  opened: ChatStreamRequest[];
  queue: ChatQueueState;
}

function queueBackend(options: {
  open: (request: ChatStreamRequest) => ChatStreamResponse;
  resume?: (request: ResumeStreamRequest) => ReadableStream<Uint8Array> | null;
  enqueue?: (request: ChatStreamRequest) => QueuedSendResult;
  thread?: Partial<ThreadDetail>;
  /** What is running when a waiting message is interrupted; `null` → nothing, so it starts. */
  running?: string | null;
}): QueueBackend {
  const backend: QueueBackend = {
    enqueued: [],
    resumed: [],
    updates: [],
    interrupted: [],
    opened: [],
    queue: { items: [], paused: null },
    async openChatStream(request) {
      backend.opened.push(request);
      return options.open(request);
    },
    async resumeChatStream(request) {
      backend.resumed.push(request);
      const body = options.resume?.(request) ?? null;
      return body === null ? null : { body };
    },
    cancelStream: async () => ({ aborted: true }),
    listThreads: async () => [],
    async getThread(id): Promise<ThreadDetail> {
      return {
        id,
        title: 'T',
        transient: false,
        createdAt: 'x',
        updatedAt: 'x',
        messages: [],
        ...options.thread,
      };
    },
    updateThread: async () => ({ ok: true }),
    deleteThread: async () => undefined,
    async enqueueMessage(request) {
      backend.enqueued.push(request);
      const result = options.enqueue?.(request) ?? {
        queued: true as const,
        threadId: 'thr-1',
        messageId: `q-${backend.enqueued.length}`,
        position: backend.queue.items.length,
        queue: {
          items: [
            ...backend.queue.items,
            view(`q-${backend.enqueued.length}`, String(request.body.message)),
          ],
          paused: null,
        },
      };
      backend.queue = result.queue;
      return result;
    },
    async updateQueuedMessage(id, update) {
      backend.updates.push({ id, update });
      const items = backend.queue.items.map((item) =>
        item.id === id && update.message !== undefined
          ? { ...item, content: update.message }
          : item,
      );
      if (update.position !== undefined) {
        const moving = items.find((item) => item.id === id);
        const rest = items.filter((item) => item.id !== id);
        if (moving !== undefined) rest.splice(update.position, 0, moving);
        backend.queue = { ...backend.queue, items: rest };
      } else {
        backend.queue = { ...backend.queue, items };
      }
      return backend.queue;
    },
    async removeQueuedMessage(id) {
      backend.queue = {
        ...backend.queue,
        items: backend.queue.items.filter((item) => item.id !== id),
      };
      return backend.queue;
    },
    async interruptQueuedMessage(id) {
      backend.interrupted.push(id);
      const moving = backend.queue.items.find((item) => item.id === id);
      const rest = backend.queue.items.filter((item) => item.id !== id);
      const running = options.running === undefined ? 'run-1' : options.running;
      if (moving === undefined) throw new Error(`queued message ${id} not found`);
      if (running === null) {
        backend.queue = { items: rest, paused: null };
        return { ...backend.queue, runId: id };
      }
      backend.queue = { items: [{ ...moving, interrupt: true }, ...rest], paused: null };
      return { ...backend.queue, interrupting: running };
    },
    clearQueue: vi.fn(async () => {
      backend.queue = { items: [], paused: null };
      return backend.queue;
    }),
    resumeQueue: vi.fn(async () => {
      const [head, ...rest] = backend.queue.items;
      backend.queue = { items: rest, paused: null };
      return { ...backend.queue, ...(head !== undefined ? { runId: head.id } : {}) };
    }),
  };
  return backend;
}

async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 30));
  });
}

function transcriptLines(messages: Array<{ role: string; parts: Array<{ type: string }> }>) {
  return messages.map(
    (message) =>
      `${message.role}: ${message.parts
        .filter((part): part is { type: 'text'; text: string } => part.type === 'text')
        .map((part) => part.text)
        .join('')}`,
  );
}

describe('useAgentChat — the message queue', () => {
  it('queues a submit made mid-turn, then attaches to the turn it becomes', async () => {
    const release = deferred();
    const backend = queueBackend({
      open: () => ({
        body: gatedStream([meta('run-1'), text('re: first')], release.promise, [
          frame({
            kind: 'queue',
            queue: { items: [], paused: null },
            started: { messageId: 'q-1', runId: 'q-1' },
          }),
          DONE,
        ]),
      }),
      resume: ({ runId }) =>
        runId === 'q-1' ? sse([meta('q-1'), text('re: second'), DONE]) : null,
    });
    const { result } = renderHook(() => useAgentChat({ backend, threadId: 'thr-1' }));
    await settle();

    await act(async () => {
      void result.current.sendMessage({ text: 'first' });
    });
    await waitFor(() => expect(result.current.status).toBe('streaming'));

    // Mid-turn the composer still sends — into the queue.
    act(() => result.current.composer.setText('second'));
    expect(result.current.composer.canSend).toBe(true);
    await act(async () => {
      await result.current.composer.submit();
    });
    expect(backend.enqueued).toHaveLength(1);
    expect(backend.enqueued[0]?.body).toMatchObject({
      threadId: 'thr-1',
      message: 'second',
      mode: 'queue',
    });
    expect(result.current.queue.items).toMatchObject([
      { id: 'q-1', text: 'second', state: 'queued' },
    ]);
    expect(result.current.transcript.queued).toMatchObject([
      { id: 'q-1', role: 'user', text: 'second', state: 'queued', isNext: true },
    ]);

    await act(async () => release.resolve());
    await settle();
    await waitFor(() =>
      expect(transcriptLines(result.current.messages)).toEqual([
        'user: first',
        'assistant: re: first',
        'user: second',
        'assistant: re: second',
      ]),
    );
    expect(backend.resumed.map((request) => request.runId)).toContain('q-1');
    expect(result.current.queue.items).toEqual([]);
    expect(result.current.runId).toBe('q-1');
  });

  it('interrupts instead, when asked to', async () => {
    const release = deferred();
    const backend = queueBackend({
      open: () => ({ body: gatedStream([meta('run-1'), text('…')], release.promise, [DONE]) }),
    });
    const { result } = renderHook(() =>
      useAgentChat({ backend, threadId: 'thr-1', whileRunning: 'interrupt' }),
    );
    await settle();
    await act(async () => {
      void result.current.sendMessage({ text: 'first' });
    });
    await waitFor(() => expect(result.current.status).toBe('streaming'));
    await act(async () => {
      await result.current.sendMessage({ text: 'actually, this' });
    });
    expect(backend.enqueued[0]?.body).toMatchObject({
      message: 'actually, this',
      mode: 'interrupt',
    });
    await act(async () => release.resolve());
  });

  it("keeps the old refusal with whileRunning: 'block'", async () => {
    const release = deferred();
    const backend = queueBackend({
      open: () => ({ body: gatedStream([meta('run-1'), text('…')], release.promise, [DONE]) }),
    });
    const { result } = renderHook(() =>
      useAgentChat({ backend, threadId: 'thr-1', whileRunning: 'block' }),
    );
    await settle();
    await act(async () => {
      void result.current.sendMessage({ text: 'first' });
    });
    await waitFor(() => expect(result.current.status).toBe('streaming'));
    act(() => result.current.composer.setText('second'));
    expect(result.current.composer.blockedBy).toBe('busy');
    await act(async () => {
      await result.current.sendMessage({ text: 'second' });
    });
    expect(backend.enqueued).toEqual([]);
    await act(async () => release.resolve());
  });

  it('edits, moves, removes and clears waiting messages', async () => {
    const backend = queueBackend({ open: () => ({ body: sse([meta('run-1'), DONE]) }) });
    backend.queue = { items: [view('a', 'a'), view('b', 'b'), view('c', 'c')], paused: null };
    const { result } = renderHook(() => useAgentChat({ backend, threadId: 'thr-1' }));
    await settle();
    // Each answer is the queue as it now stands, which the chat adopts.
    await act(async () => {
      await result.current.queue.move('c', 0);
    });
    expect(result.current.queue.items.map((item) => item.id)).toEqual(['c', 'a', 'b']);
    expect(backend.updates.at(-1)).toEqual({ id: 'c', update: { position: 0 } });

    await act(async () => {
      await result.current.queue.edit('a', 'a, edited');
    });
    expect(result.current.queue.items[1]).toMatchObject({ id: 'a', text: 'a, edited' });

    await act(async () => {
      result.current.transcript.queued.find((item) => item.id === 'b')?.remove.run();
    });
    await settle();
    expect(result.current.queue.items.map((item) => item.id)).toEqual(['c', 'a']);

    await act(async () => {
      await result.current.queue.clear();
    });
    expect(result.current.queue.items).toEqual([]);
  });

  it('reads a paused queue with the thread, and resumes it into a turn', async () => {
    const backend = queueBackend({
      open: () => ({ body: sse([meta('run-1'), DONE]) }),
      resume: ({ runId }) =>
        runId === 'w-1' ? sse([meta('w-1'), text('re: waiting'), DONE]) : null,
      thread: {
        queue: {
          items: [view('w-1', 'waiting')],
          paused: { reason: 'run_failed', message: 'model down', at: 'x' },
        },
      },
    });
    backend.queue = { items: [view('w-1', 'waiting')], paused: null };
    const { result } = renderHook(() => useAgentChat({ backend, threadId: 'thr-1' }));
    await waitFor(() =>
      expect(result.current.queue.paused).toMatchObject({ reason: 'run_failed' }),
    );
    expect(result.current.transcript.queued).toMatchObject([{ id: 'w-1', state: 'paused' }]);
    // A paused queue is not resumed by loading the thread.
    expect(backend.resumeQueue).not.toHaveBeenCalled();

    await act(async () => {
      await result.current.queue.resume();
    });
    await settle();
    await waitFor(() =>
      expect(transcriptLines(result.current.messages)).toEqual([
        'user: waiting',
        'assistant: re: waiting',
      ]),
    );
    expect(result.current.queue.paused).toBeNull();
  });

  it('starts a queue left waiting with nothing running when the thread loads', async () => {
    const backend = queueBackend({
      open: () => ({ body: sse([meta('run-1'), DONE]) }),
      resume: ({ runId }) => (runId === 'w-1' ? sse([meta('w-1'), text('re: left'), DONE]) : null),
      thread: { queue: { items: [view('w-1', 'left')], paused: null } },
    });
    backend.queue = { items: [view('w-1', 'left')], paused: null };
    const { result } = renderHook(() => useAgentChat({ backend, threadId: 'thr-1' }));
    await waitFor(() => expect(backend.resumeQueue).toHaveBeenCalledWith('thr-1'));
    await waitFor(() =>
      expect(transcriptLines(result.current.messages)).toEqual([
        'user: left',
        'assistant: re: left',
      ]),
    );
  });

  it('moves a plain send the server queued (another tab was mid-turn) into the queue', async () => {
    const queued: QueuedSendResult = {
      queued: true,
      threadId: 'thr-1',
      messageId: 'q-9',
      position: 0,
      queue: { items: [view('q-9', 'hello')], paused: null },
    };
    const backend = queueBackend({
      open: () => ({ body: sse([]), queued }),
    });
    const { result } = renderHook(() => useAgentChat({ backend, threadId: 'thr-1' }));
    await settle();
    await act(async () => {
      await result.current.sendMessage({ text: 'hello' });
    });
    await settle();
    expect(result.current.messages).toEqual([]);
    expect(result.current.queue.items).toMatchObject([{ id: 'q-9', text: 'hello' }]);
  });
  it('takes the mode per call: composer.submit({ mode }) and sendMessage(message, { mode })', async () => {
    const release = deferred();
    const backend = queueBackend({
      open: () => ({ body: gatedStream([meta('run-1'), text('…')], release.promise, [DONE]) }),
    });
    // The chat's own setting is 'queue'; one call asks for an interrupt instead.
    const { result } = renderHook(() => useAgentChat({ backend, threadId: 'thr-1' }));
    await settle();
    await act(async () => {
      // Nothing is running: `mode` says what to do mid-turn, so this is a plain send.
      void result.current.sendMessage({ text: 'first' }, { mode: 'interrupt' });
    });
    await waitFor(() => expect(result.current.status).toBe('streaming'));
    expect(backend.enqueued).toEqual([]);
    expect(backend.opened).toHaveLength(1);
    expect(backend.opened[0]?.body).not.toHaveProperty('mode');

    act(() => result.current.composer.setText('send this now'));
    await act(async () => {
      await result.current.composer.submit({ mode: 'interrupt' });
    });
    expect(backend.enqueued[0]?.body).toMatchObject({
      message: 'send this now',
      mode: 'interrupt',
    });
    // The composer cleared its own draft — the host does not.
    expect(result.current.composer.text).toBe('');

    act(() => result.current.composer.setText('and this after'));
    await act(async () => {
      await result.current.composer.submit();
    });
    expect(backend.enqueued[1]?.body).toMatchObject({ message: 'and this after', mode: 'queue' });

    await act(async () => {
      await result.current.sendMessage({ text: 'cut in' }, { mode: 'interrupt' });
    });
    expect(backend.enqueued[2]?.body).toMatchObject({ message: 'cut in', mode: 'interrupt' });
    await act(async () => {
      await result.current.sendMessage({ text: 'wait' }, { mode: 'queue' });
    });
    expect(backend.enqueued[3]?.body).toMatchObject({ message: 'wait', mode: 'queue' });
    await act(async () => release.resolve());
  });

  it("a per-call mode sends mid-turn even when the chat's own setting is 'block'", async () => {
    const release = deferred();
    const backend = queueBackend({
      open: () => ({ body: gatedStream([meta('run-1'), text('…')], release.promise, [DONE]) }),
    });
    const { result } = renderHook(() =>
      useAgentChat({ backend, threadId: 'thr-1', whileRunning: 'block' }),
    );
    await settle();
    await act(async () => {
      void result.current.sendMessage({ text: 'first' });
    });
    await waitFor(() => expect(result.current.status).toBe('streaming'));
    act(() => result.current.composer.setText('second'));
    expect(result.current.composer.blockedBy).toBe('busy');
    await act(async () => {
      await result.current.composer.submit();
    });
    expect(backend.enqueued).toEqual([]);
    expect(result.current.composer.text).toBe('second');

    await act(async () => {
      await result.current.composer.submit({ mode: 'queue' });
    });
    expect(backend.enqueued[0]?.body).toMatchObject({ message: 'second', mode: 'queue' });
    expect(result.current.composer.text).toBe('');
    await act(async () => {
      await result.current.sendMessage({ text: 'third' }, { mode: 'interrupt' });
    });
    expect(backend.enqueued[1]?.body).toMatchObject({ message: 'third', mode: 'interrupt' });
    await act(async () => release.resolve());
  });

  it('an empty draft is still refused, whatever the mode', async () => {
    const backend = queueBackend({ open: () => ({ body: sse([meta('run-1'), DONE]) }) });
    const { result } = renderHook(() => useAgentChat({ backend, threadId: 'thr-1' }));
    await settle();
    await act(async () => {
      await result.current.composer.submit({ mode: 'interrupt' });
    });
    expect(backend.enqueued).toEqual([]);
    expect(backend.opened).toEqual([]);
  });

  it('shows the queue a stop paused, which no frame of the closed stream could announce', async () => {
    const release = deferred();
    const backend = queueBackend({
      open: () => ({ body: gatedStream([meta('run-1'), text('…')], release.promise, [DONE]) }),
    });
    const { result } = renderHook(() => useAgentChat({ backend, threadId: 'thr-1' }));
    await settle();
    await act(async () => {
      void result.current.sendMessage({ text: 'first' });
    });
    await waitFor(() => expect(result.current.status).toBe('streaming'));
    await act(async () => {
      await result.current.queue.add('waiting');
    });
    // The server pauses the queue behind a Stop; the stream that would say so is already closed.
    backend.cancelStream = async () => {
      backend.queue = { items: backend.queue.items, paused: { reason: 'cancelled', at: 'x' } };
      return { aborted: true };
    };
    backend.getQueue = async () => backend.queue;

    await act(async () => {
      await result.current.cancel();
    });

    expect(result.current.queue.paused).toMatchObject({ reason: 'cancelled' });
    expect(result.current.queue.items).toHaveLength(1);
    await act(async () => release.resolve());
  });

  it('turns a waiting message into the interrupt, in place', async () => {
    const release = deferred();
    const backend = queueBackend({
      open: () => ({ body: gatedStream([meta('run-1'), text('…')], release.promise, [DONE]) }),
    });
    const { result } = renderHook(() => useAgentChat({ backend, threadId: 'thr-1' }));
    await settle();
    await act(async () => {
      void result.current.sendMessage({ text: 'first' });
    });
    await waitFor(() => expect(result.current.status).toBe('streaming'));
    await act(async () => {
      await result.current.queue.add('a');
      await result.current.queue.add('b');
    });
    const [first, second] = result.current.queue.items.map((item) => item.id);

    await act(async () => {
      await result.current.queue.interrupt(second as string);
    });
    expect(backend.interrupted).toEqual([second]);
    // One request, and the message kept its id: nothing was removed and sent again.
    expect(backend.enqueued).toHaveLength(2);
    expect(result.current.queue.items.map((item) => [item.id, item.interrupt])).toEqual([
      [second, true],
      [first, false],
    ]);
    expect(result.current.transcript.queued[0]).toMatchObject({
      id: second,
      isNext: true,
      interrupt: true,
    });
    await act(async () => release.resolve());
  });

  it('an interrupt with nothing running starts that message, and the chat attaches to it', async () => {
    const backend = queueBackend({
      open: () => ({ body: sse([meta('run-1'), DONE]) }),
      resume: ({ runId }) => (runId === 'w-2' ? sse([meta('w-2'), text('re: two'), DONE]) : null),
      running: null,
      thread: {
        queue: {
          items: [view('w-1', 'one'), view('w-2', 'two')],
          paused: { reason: 'cancelled', at: 'x' },
        },
      },
    });
    backend.queue = { items: [view('w-1', 'one'), view('w-2', 'two')], paused: null };
    const { result } = renderHook(() => useAgentChat({ backend, threadId: 'thr-1' }));
    await waitFor(() => expect(result.current.queue.items).toHaveLength(2));

    await act(async () => {
      await result.current.queue.interrupt('w-2');
    });
    await settle();
    await waitFor(() =>
      expect(transcriptLines(result.current.messages)).toEqual(['user: two', 'assistant: re: two']),
    );
    expect(result.current.queue.items.map((item) => item.id)).toEqual(['w-1']);
    expect(result.current.queue.paused).toBeNull();
  });

  it('reports a failed interrupt on queue.error and puts the queue back', async () => {
    const backend = queueBackend({ open: () => ({ body: sse([meta('run-1'), DONE]) }) });
    backend.interruptQueuedMessage = async () => {
      throw new Error('gone');
    };
    const { result } = renderHook(() => useAgentChat({ backend, threadId: 'thr-1' }));
    await settle();
    await act(async () => {
      await result.current.queue.add('a');
      await result.current.queue.add('b');
    });
    const before = result.current.queue.items.map((item) => item.id);
    await act(async () => {
      await expect(result.current.queue.interrupt(before[1] as string)).rejects.toThrow('gone');
    });
    expect(result.current.queue.items.map((item) => item.id)).toEqual(before);
    expect(result.current.queue.error?.message).toBe('gone');
  });

  it('gives a waiting message its files in the shape a sent message has', async () => {
    const attachment = {
      mediaId: 'm-1',
      url: 'https://files.test/report.PDF',
      contentType: 'application/pdf',
      name: 'report.PDF',
    };
    const backend = queueBackend({
      open: () => ({ body: sse([meta('run-1'), DONE]) }),
      thread: {
        queue: {
          items: [view('w-1', 'read this', { attachments: [attachment] })],
          paused: { reason: 'cancelled', at: 'x' },
        },
      },
    });
    const { result } = renderHook(() => useAgentChat({ backend, threadId: 'thr-1' }));
    await waitFor(() => expect(result.current.queue.items).toHaveLength(1));
    // What `messageFiles()` gives for the message this becomes once it is sent.
    const sent = messageFiles({
      parts: [
        {
          type: 'file',
          mediaType: attachment.contentType,
          filename: attachment.name,
          url: attachment.url,
          providerMetadata: { agent: { mediaId: attachment.mediaId } },
        },
      ],
    });
    expect(sent).toEqual([
      {
        url: attachment.url,
        mediaType: 'application/pdf',
        filename: 'report.PDF',
        kind: 'pdf',
        extension: 'pdf',
        mediaId: 'm-1',
      },
    ]);
    expect(result.current.queue.items[0]?.files).toEqual(sent);
    expect(result.current.transcript.queued[0]?.files).toEqual([{ ...sent[0], isImage: false }]);
    // The raw attachments are still there for a host that re-sends them.
    expect(result.current.queue.items[0]?.attachments).toEqual([attachment]);
  });
});
