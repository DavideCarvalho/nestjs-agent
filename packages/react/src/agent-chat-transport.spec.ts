import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import { describe, expect, it } from 'vitest';
import { AgentChatTransport, type AgentStreamMeta } from './agent-chat-transport.js';

function sseStream(frames: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}

function fakeFetch(stream: ReadableStream<Uint8Array>): typeof fetch {
  const response = {
    ok: true,
    status: 200,
    statusText: 'OK',
    body: stream,
    headers: new Headers({
      'x-agent-run-id': 'run-header',
      'x-agent-thread-id': 'thr-header',
    }),
  };
  return (async () => response) as unknown as typeof fetch;
}

async function collect(stream: ReadableStream<UIMessageChunk>): Promise<UIMessageChunk[]> {
  const reader = stream.getReader();
  const out: UIMessageChunk[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    out.push(value);
  }
  return out;
}

const userMessage: UIMessage = {
  id: 'm1',
  role: 'user',
  parts: [{ type: 'text', text: 'hello' }],
};

function sendArgs(): Parameters<ChatTransport<UIMessage>['sendMessages']>[0] {
  return {
    trigger: 'submit-message',
    chatId: 'thr-1',
    messageId: undefined,
    messages: [userMessage],
    abortSignal: undefined,
  };
}

describe('AgentChatTransport', () => {
  it('parses meta + delta + done into a v7 UI-message chunk stream', async () => {
    const captured: AgentStreamMeta[] = [];
    const transport = new AgentChatTransport({
      fetch: fakeFetch(
        sseStream([
          'event: meta\ndata: {"runId":"run-1","threadId":"thr-1"}\n\n',
          'data: {"delta":"Hello"}\n\n',
          'data: {"delta":" world"}\n\n',
          'event: done\ndata: {}\n\n',
        ]),
      ),
      onMeta: (meta) => captured.push(meta),
    });

    const chunks = await collect(await transport.sendMessages(sendArgs()));
    const types = chunks.map((chunk) => chunk.type);

    expect(types).toEqual([
      'start',
      'start-step',
      'text-start',
      'text-delta',
      'text-delta',
      'text-end',
      'finish-step',
      'finish',
    ]);

    const text = chunks
      .filter(
        (chunk): chunk is Extract<UIMessageChunk, { type: 'text-delta' }> =>
          chunk.type === 'text-delta',
      )
      .map((chunk) => chunk.delta)
      .join('');
    expect(text).toBe('Hello world');
  });

  it('surfaces runId/threadId from the meta frame', async () => {
    const transport = new AgentChatTransport({
      fetch: fakeFetch(
        sseStream([
          'event: meta\ndata: {"runId":"run-1","threadId":"thr-1"}\n\n',
          'data: {"delta":"hi"}\n\n',
          'event: done\ndata: {}\n\n',
        ]),
      ),
    });

    await collect(await transport.sendMessages(sendArgs()));

    // The meta frame wins over the header fallback.
    expect(transport.runId).toBe('run-1');
    expect(transport.threadId).toBe('thr-1');
  });

  it('returns null from reconnectToStream when no run is resumable', async () => {
    const transport = new AgentChatTransport({
      fetch: (() => {
        throw new Error('reconnect must not hit the network');
      }) as unknown as typeof fetch,
      getResumeRunId: () => undefined,
    });

    const result = await transport.reconnectToStream({ chatId: 'thr-1' });
    expect(result).toBeNull();
  });
});
