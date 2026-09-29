import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import { describe, expect, it } from 'vitest';
import { AgentChatTransport } from './agent-chat-transport.js';

function sse(events: unknown[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const frames = [
    'event: meta\ndata: {"runId":"run-1","threadId":"thr-1"}\n\n',
    ...events.map((event) => `data: ${JSON.stringify(event)}\n\n`),
    'event: done\ndata: {}\n\n',
  ];
  return new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(frame));
      controller.close();
    },
  });
}

async function chunksFor(events: unknown[]): Promise<UIMessageChunk[]> {
  const body = sse(events);
  const transport = new AgentChatTransport({
    fetch: (async () => ({
      ok: true,
      status: 200,
      statusText: 'OK',
      body,
      headers: new Headers(),
    })) as unknown as typeof fetch,
  });
  const args: Parameters<ChatTransport<UIMessage>['sendMessages']>[0] = {
    trigger: 'submit-message',
    chatId: 'thr-1',
    messageId: undefined,
    messages: [{ id: 'u1', role: 'user', parts: [{ type: 'text', text: 'hi' }] }],
    abortSignal: undefined,
  };
  const reader = (await transport.sendMessages(args)).getReader();
  const out: UIMessageChunk[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

describe('AgentChatTransport — generative UI, title, approval, nesting', () => {
  it('maps a ui frame to a data-ui part keyed by the component id', async () => {
    const chunks = await chunksFor([
      { kind: 'step-start' },
      { kind: 'ui', id: 'ui-1', component: 'data-table', props: { rows: [1] }, version: 2 },
      { kind: 'step-finish' },
    ]);
    expect(chunks).toContainEqual({
      type: 'data-ui',
      id: 'ui-1',
      data: { id: 'ui-1', component: 'data-table', props: { rows: [1] }, version: 2 },
    });
  });

  it('carries the pushing tool call on the data-ui part', async () => {
    const chunks = await chunksFor([
      { kind: 'step-start' },
      { kind: 'tool-input-available', id: 'c1', name: 'chart', input: {}, toolKind: 'read' },
      { kind: 'ui', id: 'c1:ui:0', component: 'Chart', props: {}, toolCallId: 'c1' },
      { kind: 'tool-output', id: 'c1', output: {} },
      { kind: 'step-finish' },
    ]);
    expect(chunks).toContainEqual({
      type: 'data-ui',
      id: 'c1:ui:0',
      data: { id: 'c1:ui:0', component: 'Chart', props: {}, toolCallId: 'c1' },
    });
  });

  it('closes the open prose at a ui frame so later text lands after the component', async () => {
    const chunks = await chunksFor([
      { kind: 'step-start' },
      { kind: 'text', text: 'Here it is:' },
      { kind: 'ui', id: 'ui-1', component: 'chart', props: {} },
      { kind: 'text', text: 'And more.' },
      { kind: 'step-finish' },
    ]);
    expect(
      chunks.map((chunk) => ('id' in chunk ? `${chunk.type}:${chunk.id}` : chunk.type)),
    ).toEqual([
      'start',
      'start-step',
      'text-start:txt-1',
      'text-delta:txt-1',
      'text-end:txt-1',
      'data-ui:ui-1',
      'text-start:txt-1.1',
      'text-delta:txt-1.1',
      'text-end:txt-1.1',
      'finish-step',
      'finish',
    ]);
  });

  it('forwards a title as a transient data-title chunk', async () => {
    const chunks = await chunksFor([{ kind: 'title', title: 'Revenue by region' }]);
    expect(chunks).toContainEqual({
      type: 'data-title',
      data: { title: 'Revenue by region' },
      transient: true,
    });
  });

  it('moves an announced call into the native approval state and carries who decides as data', async () => {
    const chunks = await chunksFor([
      { kind: 'step-start' },
      {
        kind: 'tool-input-available',
        id: 'call-1',
        name: 'sendEmail',
        input: { to: 'a@b.c' },
        toolKind: 'action',
      },
      {
        kind: 'approval-requested',
        id: 'call-1',
        approver: 'admin',
        expiresAt: '2026-10-01T00:00:00.000Z',
        reason: 'Emails a customer',
      },
    ]);
    expect(chunks).toContainEqual({
      type: 'data-approval-requested',
      id: 'call-1',
      data: {
        id: 'call-1',
        approver: 'admin',
        expiresAt: '2026-10-01T00:00:00.000Z',
        reason: 'Emails a customer',
      },
    });
    expect(chunks).toContainEqual({
      type: 'tool-approval-request',
      approvalId: 'call-1',
      toolCallId: 'call-1',
    });
  });

  it('never sends the native approval chunk for a call the stream did not announce', async () => {
    const chunks = await chunksFor([
      { kind: 'approval-requested', id: 'ghost', approver: 'requester' },
    ]);
    expect(chunks.some((chunk) => chunk.type === 'tool-approval-request')).toBe(false);
    expect(chunks).toContainEqual({
      type: 'data-approval-requested',
      id: 'ghost',
      data: { id: 'ghost', approver: 'requester' },
    });
  });

  it('forwards approval-settled as a data part keyed by the call', async () => {
    const chunks = await chunksFor([
      {
        kind: 'approval-settled',
        id: 'call-1',
        status: 'approved',
        decidedBy: 'op-1',
        decidedVia: 'slack',
        remember: true,
      },
    ]);
    expect(chunks).toContainEqual({
      type: 'data-approval-settled',
      id: 'call-1',
      data: {
        id: 'call-1',
        status: 'approved',
        decidedBy: 'op-1',
        decidedVia: 'slack',
        remember: true,
      },
    });
  });

  it('carries parentId in toolMetadata and keeps it when the input lands', async () => {
    const chunks = await chunksFor([
      { kind: 'step-start' },
      { kind: 'tool-input-start', id: 'outer', name: 'execute', toolKind: 'read' },
      {
        kind: 'tool-input-start',
        id: 'inner',
        name: 'search',
        toolKind: 'read',
        parentId: 'outer',
      },
      { kind: 'tool-input-available', id: 'inner', name: 'search', input: {}, toolKind: 'read' },
    ]);
    const inner = chunks.filter(
      (chunk) => 'toolCallId' in chunk && chunk.toolCallId === 'inner' && 'toolMetadata' in chunk,
    );
    expect(inner.map((chunk) => (chunk as { toolMetadata: unknown }).toolMetadata)).toEqual([
      { toolKind: 'read', parentId: 'outer' },
      { toolKind: 'read', parentId: 'outer' },
    ]);
  });

  it('forwards a kind it does not know as data-<kind> instead of dropping it', async () => {
    const chunks = await chunksFor([{ kind: 'skill', id: 's1', name: 'pdf' }]);
    expect(chunks).toContainEqual({
      type: 'data-skill',
      id: 's1',
      data: { id: 's1', name: 'pdf' },
    });
  });

  it('forwards cancelled as transient data so a host can tell a truncated answer apart', async () => {
    const chunks = await chunksFor([{ kind: 'cancelled' }]);
    expect(chunks).toContainEqual({ type: 'data-cancelled', data: {}, transient: true });
  });

  it("stamps the backend's thinking time on the reasoning part's end", async () => {
    const chunks = await chunksFor([
      { kind: 'step-start' },
      { kind: 'reasoning', text: 'hmm' },
      { kind: 'step-finish', reasoningMs: 4_200 },
    ]);
    expect(chunks).toContainEqual({
      type: 'reasoning-end',
      id: 'rsn-1',
      providerMetadata: { agent: { reasoningMs: 4_200 } },
    });
  });

  it('falls back to the time it watched the reasoning stream when the backend reports none', async () => {
    const chunks = await chunksFor([
      { kind: 'step-start' },
      { kind: 'reasoning', text: 'hmm' },
      { kind: 'step-finish' },
    ]);
    const end = chunks.find((chunk) => chunk.type === 'reasoning-end') as {
      providerMetadata?: { agent?: { reasoningMs?: unknown } };
    };
    expect(typeof end.providerMetadata?.agent?.reasoningMs).toBe('number');
  });
});
