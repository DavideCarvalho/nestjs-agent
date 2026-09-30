import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import { describe, expect, it, vi } from 'vitest';
import { AgentChatTransport, type StreamConnectionState } from './agent-chat-transport.js';
import type { AgentBackend, ChatStreamResponse, ResumeStreamRequest } from './backend.js';
import { AgentClient } from './client.js';

const encoder = new TextEncoder();

/** Hands out `frames` one per read, then ends — or, with `drop`, fails the read like a lost socket. */
function stream(frames: string[], end: 'close' | 'drop' = 'close'): ReadableStream<Uint8Array> {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const frame = frames[index];
      index += 1;
      if (frame !== undefined) {
        controller.enqueue(encoder.encode(frame));
      } else if (end === 'drop') {
        controller.error(new TypeError('network error'));
      } else {
        controller.close();
      }
    },
  });
}

function response(body: ReadableStream<Uint8Array>): ChatStreamResponse {
  return { body, runId: 'run-1', threadId: 'thr-1' };
}

function backendWith(
  open: ReadableStream<Uint8Array>,
  resumes: Array<ReadableStream<Uint8Array> | null | Error>,
): AgentBackend & { resumed: ResumeStreamRequest[]; opened: unknown[] } {
  const resumed: ResumeStreamRequest[] = [];
  const opened: unknown[] = [];
  return {
    resumed,
    opened,
    async openChatStream(request) {
      opened.push(request);
      return response(open);
    },
    async resumeChatStream(request) {
      resumed.push(request);
      const next = resumes.shift();
      if (next instanceof Error) throw next;
      if (next === null || next === undefined) return null;
      return response(next);
    },
    cancelStream: async () => ({ aborted: true }),
    listThreads: async () => [],
    getThread: async () => {
      throw new Error('unused');
    },
    updateThread: async () => ({ ok: true }),
    deleteThread: async () => undefined,
  };
}

async function collect(chunks: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const reader = chunks.getReader();
  const out: UIMessageChunk[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

function sendArgs(): Parameters<ChatTransport<UIMessage>['sendMessages']>[0] {
  return {
    trigger: 'submit-message',
    chatId: 'thr-1',
    messageId: undefined,
    messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'hello' }] }],
    abortSignal: undefined,
  };
}

function textOf(chunks: UIMessageChunk[]): string {
  return chunks
    .filter((chunk): chunk is Extract<UIMessageChunk, { type: 'text-delta' }> => {
      return chunk.type === 'text-delta';
    })
    .map((chunk) => chunk.delta)
    .join('');
}

const META = 'event: meta\ndata: {"runId":"run-1","threadId":"thr-1"}\n\n';
const frame = (id: number, event: object) => `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
const DONE = 'event: done\ndata: {}\n\n';

describe('AgentChatTransport with a pluggable backend', () => {
  it('starts the turn through the backend, never through fetch', async () => {
    const fetchSpy = vi.fn();
    const backend = backendWith(stream([META, frame(1, { kind: 'text', text: 'hi' }), DONE]), []);
    const transport = new AgentChatTransport({
      backend,
      agent: 'support',
      fetch: fetchSpy as unknown as typeof fetch,
      getBody: () => ({ threadId: 'thr-1' }),
    });

    const chunks = await collect(
      await transport.sendMessages({ ...sendArgs(), headers: { 'x-extra': '1' } }),
    );

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(backend.opened).toEqual([
      {
        body: { agent: 'support', threadId: 'thr-1', message: 'hello' },
        headers: { 'x-extra': '1' },
      },
    ]);
    expect(textOf(chunks)).toBe('hi');
    expect(transport.runId).toBe('run-1');
  });
});

describe('AgentChatTransport reconnect', () => {
  it('resumes a dropped stream after the last frame it saw, continuing the same message', async () => {
    const states: StreamConnectionState[] = [];
    const backend = backendWith(
      stream(
        [
          META,
          frame(1, { kind: 'step-start' }),
          frame(2, { kind: 'text', text: 'Hel' }),
          // half a frame arrives before the socket dies — it is resent after the reconnect
          'id: 3\ndata: {"kind":"te',
        ],
        'drop',
      ),
      [
        stream([
          META,
          frame(3, { kind: 'text', text: 'lo' }),
          frame(4, { kind: 'step-finish' }),
          DONE,
        ]),
      ],
    );
    const transport = new AgentChatTransport({
      backend,
      reconnect: { baseDelayMs: 0 },
      onConnectionChange: (state) => states.push(state),
    });

    const chunks = await collect(await transport.sendMessages(sendArgs()));

    expect(backend.resumed).toEqual([{ runId: 'run-1', after: 2 }]);
    expect(textOf(chunks)).toBe('Hello');
    expect(chunks.filter((chunk) => chunk.type === 'start')).toHaveLength(1);
    expect(chunks.filter((chunk) => chunk.type === 'text-start')).toHaveLength(1);
    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false);
    expect(chunks.at(-1)?.type).toBe('finish');
    expect(states).toEqual([
      { status: 'reconnecting', runId: 'run-1', attempt: 1, after: 2 },
      { status: 'live' },
    ]);
    expect(transport.isAttemptLive).toBe(false);
  });

  it('treats a numbered stream that closes without `done` as dropped', async () => {
    const backend = backendWith(stream([META, frame(1, { kind: 'text', text: 'a' })]), [
      stream([frame(2, { kind: 'text', text: 'b' }), DONE]),
    ]);
    const transport = new AgentChatTransport({ backend, reconnect: { baseDelayMs: 0 } });

    const chunks = await collect(await transport.sendMessages(sendArgs()));

    expect(backend.resumed).toEqual([{ runId: 'run-1', after: 1 }]);
    expect(textOf(chunks)).toBe('ab');
  });

  it('drops frames a server resends at or below the cursor', async () => {
    const backend = backendWith(stream([META, frame(1, { kind: 'text', text: 'a' })], 'drop'), [
      stream([
        META,
        frame(1, { kind: 'text', text: 'a' }),
        frame(2, { kind: 'text', text: 'b' }),
        DONE,
      ]),
    ]);
    const transport = new AgentChatTransport({ backend, reconnect: { baseDelayMs: 0 } });

    expect(textOf(await collect(await transport.sendMessages(sendArgs())))).toBe('ab');
  });

  it('resumes a runner whose ids are increasing but not contiguous (rebuilt from checkpoints)', async () => {
    // A runner that numbers frames from durable positions (step × 1000 + index) rather than a
    // counter: the ids jump, and a stream rebuilt after a restart condenses what already streamed
    // into fewer frames numbered at or below what the client has — only the rest is new.
    const backend = backendWith(
      stream(
        [
          META,
          frame(1_000, { kind: 'step-start' }),
          frame(1_001, { kind: 'text', text: 'Hel' }),
          frame(1_002, { kind: 'text', text: 'lo' }),
        ],
        'drop',
      ),
      [
        stream([
          META,
          frame(1_000, { kind: 'step-start' }),
          frame(1_001, { kind: 'text', text: 'Hello' }),
          frame(4_000, { kind: 'text', text: ', world' }),
          DONE,
        ]),
      ],
    );
    const transport = new AgentChatTransport({ backend, reconnect: { baseDelayMs: 0 } });

    expect(textOf(await collect(await transport.sendMessages(sendArgs())))).toBe('Hello, world');
    expect(backend.resumed[0]?.after).toBe(1_002);
  });

  it('retries with backoff, and gives up with an error after the last attempt', async () => {
    const states: StreamConnectionState[] = [];
    const backend = backendWith(stream([META, frame(1, { kind: 'text', text: 'a' })], 'drop'), [
      new Error('offline'),
      new Error('offline'),
      new Error('offline'),
    ]);
    const transport = new AgentChatTransport({
      backend,
      reconnect: { baseDelayMs: 0, maxAttempts: 3 },
      onConnectionChange: (state) => states.push(state),
    });

    const chunks = await collect(await transport.sendMessages(sendArgs()));

    expect(backend.resumed).toHaveLength(3);
    expect(chunks.at(-1)).toEqual({
      type: 'error',
      errorText: 'Lost the connection to the agent stream',
    });
    expect(states.map((state) => state.status)).toEqual([
      'reconnecting',
      'reconnecting',
      'reconnecting',
      'failed',
    ]);
    expect(transport.isAttemptLive).toBe(false);
  });

  it('finishes what it has when the run ended while it was away', async () => {
    const states: StreamConnectionState[] = [];
    const backend = backendWith(stream([META, frame(1, { kind: 'text', text: 'a' })], 'drop'), [
      null,
    ]);
    const transport = new AgentChatTransport({
      backend,
      reconnect: { baseDelayMs: 0 },
      onConnectionChange: (state) => states.push(state),
    });

    const chunks = await collect(await transport.sendMessages(sendArgs()));

    expect(chunks.at(-1)?.type).toBe('finish');
    expect(states.at(-1)).toEqual({ status: 'gone', runId: 'run-1' });
  });

  it('does not reconnect to a server that does not number its frames', async () => {
    const backend = backendWith(stream([META, 'data: {"kind":"text","text":"a"}\n\n'], 'drop'), []);
    const transport = new AgentChatTransport({ backend, reconnect: { baseDelayMs: 0 } });

    const chunks = await collect(await transport.sendMessages(sendArgs()));

    expect(backend.resumed).toEqual([]);
    expect(chunks.at(-1)).toEqual({ type: 'error', errorText: 'network error' });
  });

  it('does not reconnect when turned off', async () => {
    const backend = backendWith(stream([META, frame(1, { kind: 'text', text: 'a' })], 'drop'), []);
    const transport = new AgentChatTransport({ backend, reconnect: false });

    const chunks = await collect(await transport.sendMessages(sendArgs()));

    expect(backend.resumed).toEqual([]);
    expect(chunks.at(-1)?.type).toBe('error');
  });
});

describe('AgentClient streams', () => {
  function fakeFetch(status: number) {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const impl = async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: status >= 200 && status < 300,
        status,
        statusText: String(status),
        body: stream([DONE]),
        headers: new Headers({ 'x-agent-run-id': 'run-9', 'x-agent-thread-id': 'thr-9' }),
      };
    };
    return { calls, fetch: impl as unknown as typeof fetch };
  }

  it('resumes after a cursor with the cookie credentials and a per-request CSRF header', async () => {
    const { calls, fetch } = fakeFetch(200);
    let token = 'csrf-1';
    const client = new AgentClient({
      baseUrl: 'https://api.test/',
      credentials: 'include',
      getHeaders: () => ({ 'X-XSRF-TOKEN': token }),
      fetch,
    });

    token = 'csrf-2';
    const resumed = await client.resumeChatStream({ runId: 'run 9', after: 7 });

    expect(resumed).toMatchObject({ runId: 'run-9', threadId: 'thr-9' });
    expect(calls[0]?.url).toBe('https://api.test/agent/chat/run%209/stream?after=7');
    expect(calls[0]?.init.credentials).toBe('include');
    expect(calls[0]?.init.headers).toMatchObject({ 'X-XSRF-TOKEN': 'csrf-2' });
  });

  it('a stop whose request was already aborted leaves no unhandled rejection', async () => {
    // What fetch does on abort: the body errors, and cancelling it rejects with the AbortError.
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(META + frame(1, { kind: 'text', text: 'partial' })));
      },
      cancel() {
        throw new DOMException('BodyStreamBuffer was aborted', 'AbortError');
      },
    });
    const transport = new AgentChatTransport({ backend: backendWith(body, []), agent: 'support' });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on('unhandledRejection', onUnhandled);
    try {
      const reader = (await transport.sendMessages(sendArgs())).getReader();
      await reader.read();
      await reader.cancel();
      await new Promise((resolve) => setTimeout(resolve, 20));
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
    expect(unhandled).toEqual([]);
  });

  it('reads a 404 resume as nothing to resume', async () => {
    const { fetch } = fakeFetch(404);
    expect(await new AgentClient({ fetch }).resumeChatStream({ runId: 'r' })).toBeNull();
  });

  it('posts a message rating', async () => {
    const calls: Array<{ url: string; init: RequestInit }> = [];
    const fetch = (async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        statusText: 'OK',
        text: async () => '{"feedback":{"value":"up","updatedAt":"2026-01-01T00:00:00.000Z"}}',
      };
    }) as unknown as typeof globalThis.fetch;

    const result = await new AgentClient({ fetch }).setMessageFeedback('m 1', { value: 'up' });

    expect(calls[0]?.url).toBe('/agent/messages/m%201/feedback');
    expect(calls[0]?.init.method).toBe('POST');
    expect(calls[0]?.init.body).toBe('{"value":"up"}');
    expect(result.feedback?.value).toBe('up');
  });
});
