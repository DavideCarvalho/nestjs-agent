import { describe, expect, it, vi } from 'vitest';
import { agUiChatStream, reframeAgUiStream } from './ag-ui-backend.js';

/** An AG-UI SSE body, one event per `data:` line, as a producer writes it. */
function agUiBody(events: Record<string, unknown>[]): ReadableStream<Uint8Array> {
  const text = events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join('');
  const bytes = new TextEncoder().encode(text);
  return new ReadableStream({
    start(controller) {
      // split in two, mid-event, as the network would
      controller.enqueue(bytes.slice(0, 37));
      controller.enqueue(bytes.slice(37));
      controller.close();
    },
  });
}

async function read(stream: ReadableStream<Uint8Array>): Promise<string> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let out = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) return out;
    out += decoder.decode(value, { stream: true });
  }
}

/** The frames of the native framing: `{ event, id, data }`. */
function frames(text: string) {
  return text
    .split('\n\n')
    .filter((block) => block.trim().length > 0)
    .map((block) => {
      const lines = block.split('\n');
      const event = lines
        .find((line) => line.startsWith('event:'))
        ?.slice(6)
        .trim();
      const id = lines
        .find((line) => line.startsWith('id:'))
        ?.slice(3)
        .trim();
      const data = lines
        .find((line) => line.startsWith('data:'))
        ?.slice(5)
        .trim();
      return {
        event,
        id: id === undefined ? undefined : Number(id),
        data: data ? JSON.parse(data) : undefined,
      };
    });
}

const run = [
  { type: 'RUN_STARTED', threadId: 't1', runId: 'r1', protocolVersion: '1.0' },
  { type: 'CUSTOM', name: 'agora.run', value: { runId: 'lib-run', threadId: 't1' } },
  { type: 'STEP_STARTED', stepName: 'step-1' },
  { type: 'TEXT_MESSAGE_START', messageId: 'm1', role: 'assistant' },
  { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm1', delta: 'Olhando ' },
  { type: 'TEXT_MESSAGE_END', messageId: 'm1' },
  {
    type: 'TOOL_CALL_START',
    toolCallId: 'c1',
    toolCallName: 'get_month_spending',
    parentMessageId: 'm1',
  },
  { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '{"month":' },
  { type: 'TOOL_CALL_ARGS', toolCallId: 'c1', delta: '"2026-09"}' },
  { type: 'TOOL_CALL_END', toolCallId: 'c1' },
  { type: 'STEP_FINISHED', stepName: 'step-1' },
  {
    type: 'TOOL_CALL_RESULT',
    messageId: 't',
    toolCallId: 'c1',
    content: '{"total":12}',
    role: 'tool',
  },
  {
    type: 'CUSTOM',
    name: 'agora.ui',
    value: { id: 'u1', component: 'Spending', props: { total: 12 } },
  },
  { type: 'CUSTOM', name: 'com.other.thing', value: { ignored: true } },
  { type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' },
];

describe('reframeAgUiStream', () => {
  it('re-frames an AG-UI run in the native stream protocol', async () => {
    const out = frames(await read(reframeAgUiStream(agUiBody(run), { threadId: 't1' })));
    expect(out[0]).toEqual({
      event: 'meta',
      id: undefined,
      data: { runId: 'lib-run', threadId: 't1' },
    });
    const events = out.filter((frame) => frame.event === undefined).map((frame) => frame.data);
    expect(events).toEqual([
      { kind: 'step-start' },
      { kind: 'text', text: 'Olhando ' },
      { kind: 'tool-input-start', id: 'c1', name: 'get_month_spending', toolKind: 'read' },
      { kind: 'tool-input-delta', id: 'c1', delta: '{"month":' },
      { kind: 'tool-input-delta', id: 'c1', delta: '"2026-09"}' },
      {
        kind: 'tool-input-available',
        id: 'c1',
        name: 'get_month_spending',
        input: { month: '2026-09' },
        toolKind: 'read',
      },
      { kind: 'step-finish' },
      { kind: 'tool-output', id: 'c1', output: { total: 12 } },
      { kind: 'ui', id: 'u1', component: 'Spending', props: { total: 12 } },
    ]);
    // numbered 1..n, and the stream ends with done
    expect(out.filter((frame) => frame.id !== undefined).map((frame) => frame.id)).toEqual(
      events.map((_, index) => index + 1),
    );
    expect(out.at(-1)).toEqual({ event: 'done', id: undefined, data: {} });
  });

  it('turns RUN_ERROR into the error frame, and marks failed and denied results', async () => {
    const out = frames(
      await read(
        reframeAgUiStream(
          agUiBody([
            { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' },
            { type: 'TOOL_CALL_START', toolCallId: 'a', toolCallName: 'x' },
            { type: 'TOOL_CALL_END', toolCallId: 'a' },
            {
              type: 'TOOL_CALL_RESULT',
              messageId: 'm',
              toolCallId: 'a',
              content: 'boom',
              metadata: { 'agora.outcome': 'error' },
            },
            {
              type: 'TOOL_CALL_RESULT',
              messageId: 'n',
              toolCallId: 'b',
              content: [{ type: 'text', text: 'no' }],
              metadata: { 'agora.outcome': 'denied' },
            },
            { type: 'RUN_ERROR', message: 'Falhou.', code: 'run_failed' },
            { type: 'TEXT_MESSAGE_CONTENT', messageId: 'z', delta: 'after the end' },
          ]),
          { threadId: 't1' },
        ),
      ),
    );
    // without `agora.run`, the protocol's own run id names the run
    expect(out[0]?.data).toEqual({ runId: 'r1', threadId: 't1' });
    expect(out.map((frame) => frame.data)).toContainEqual({
      kind: 'tool-output-error',
      id: 'a',
      error: 'boom',
    });
    expect(out.map((frame) => frame.data)).toContainEqual({
      kind: 'tool-output-denied',
      id: 'b',
      reason: 'no',
    });
    expect(out.at(-1)).toEqual({
      event: 'error',
      id: undefined,
      data: { code: 'run_failed', message: 'Falhou.' },
    });
    expect(JSON.stringify(out)).not.toContain('after the end');
  });

  it('writes cancelled before done, and hands interrupts to the app as a ui part', async () => {
    const cancelled = frames(
      await read(
        reframeAgUiStream(
          agUiBody([
            { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' },
            { type: 'RUN_FINISHED', threadId: 't1', runId: 'r1', outcome: { type: 'cancelled' } },
          ]),
          { threadId: 't1' },
        ),
      ),
    );
    expect(cancelled.slice(-2).map((frame) => frame.data)).toEqual([{ kind: 'cancelled' }, {}]);
    const interrupted = frames(
      await read(
        reframeAgUiStream(
          agUiBody([
            { type: 'RUN_STARTED', threadId: 't1', runId: 'r2' },
            {
              type: 'RUN_FINISHED',
              threadId: 't1',
              runId: 'r2',
              outcome: { type: 'interrupt', interrupts: [{ id: 'i1', reason: 'tool_approval' }] },
            },
          ]),
          { threadId: 't1' },
        ),
      ),
    );
    expect(interrupted.map((frame) => frame.data)).toContainEqual({
      kind: 'ui',
      id: 'ag-ui:interrupt:r2',
      component: 'AgUiInterrupt',
      props: { interrupts: [{ id: 'i1', reason: 'tool_approval' }] },
    });
  });
});

describe('agUiChatStream', () => {
  it('POSTs a RunAgentInput for the send and names the thread it started', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(agUiBody(run), { status: 200, headers: { 'x-agent-run-id': 'lib-run' } }),
    );
    const response = await agUiChatStream(
      {
        body: { message: 'Quanto gastei?', pageContext: { readingId: 'r-1' } },
        headers: { 'x-csrf-token': 'tok' },
      },
      {
        url: '/api/assistant/ag-ui',
        headers: { authorization: 'x' },
        fetch: fetch as unknown as typeof globalThis.fetch,
      },
    );
    const [url, init] = fetch.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('/api/assistant/ag-ui');
    expect(init.headers).toMatchObject({
      'x-csrf-token': 'tok',
      authorization: 'x',
      accept: 'text/event-stream',
    });
    const input = JSON.parse(String(init.body));
    expect(input).toMatchObject({
      protocolVersion: '1.0',
      messages: [{ role: 'user', content: 'Quanto gastei?' }],
      forwardedProps: { pageContext: { readingId: 'r-1' } },
    });
    expect(response.threadId).toBe(input.threadId);
    expect(response.runId).toBe('lib-run');
    expect(await read(response.body)).toContain('event: done');
  });

  it('continues the thread the send names, and surfaces a refusal', async () => {
    const fetch = vi.fn(
      async () =>
        new Response(JSON.stringify({ message: 'A conversa volta amanhã.' }), { status: 429 }),
    );
    await expect(
      agUiChatStream(
        { body: { message: 'oi', threadId: 't9' } },
        { url: '/x', fetch: fetch as unknown as typeof globalThis.fetch },
      ),
    ).rejects.toThrow('A conversa volta amanhã.');
    const input = JSON.parse(
      String((fetch.mock.calls[0] as unknown as [string, RequestInit])[1].body),
    );
    expect(input.threadId).toBe('t9');
  });
});
