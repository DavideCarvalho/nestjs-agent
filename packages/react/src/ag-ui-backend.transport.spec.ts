import type { ChatTransport, UIMessage, UIMessageChunk } from 'ai';
import { describe, expect, it } from 'vitest';
import { reframeAgUiStream } from './ag-ui-backend.js';
import { AgentChatTransport } from './agent-chat-transport.js';
import type { AgentBackend, ResumeStreamRequest } from './backend.js';

/**
 * `agUiChatStream` behind `useAgentChat`'s transport: what the re-framed AG-UI stream does to the
 * chat once the run stops to ask, and on a text decision.
 */

const encoder = new TextEncoder();

function body(text: string): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

/** An AG-UI body as this library's producer writes it: the run's sequence as each event's id. */
function agUi(events: [number | undefined, Record<string, unknown>][]): string {
  return events
    .map(
      ([id, event]) => `${id !== undefined ? `id: ${id}\n` : ''}data: ${JSON.stringify(event)}\n\n`,
    )
    .join('');
}

function backendWith(
  open: string,
  resumes: string[],
): AgentBackend & { resumed: ResumeStreamRequest[] } {
  const resumed: ResumeStreamRequest[] = [];
  return {
    resumed,
    async openChatStream() {
      return { body: reframeAgUiStream(body(open), { threadId: 't1' }), threadId: 't1' };
    },
    async resumeChatStream(request) {
      resumed.push(request);
      const next = resumes.shift();
      return next === undefined ? null : { body: body(next), runId: request.runId, threadId: 't1' };
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
  for (;;) {
    const { done, value } = await reader.read();
    if (done) return out;
    out.push(value);
  }
}

function sendArgs(): Parameters<ChatTransport<UIMessage>['sendMessages']>[0] {
  return {
    trigger: 'submit-message',
    chatId: 't1',
    messageId: undefined,
    messages: [{ id: 'm1', role: 'user', parts: [{ type: 'text', text: 'refund 7' }] }],
    abortSignal: undefined,
  };
}

describe('useAgentChat over AG-UI', () => {
  it('re-attaches to the parked run at its own sequence and streams the rest into the same message', async () => {
    const backend = backendWith(
      agUi([
        [undefined, { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }],
        [undefined, { type: 'CUSTOM', name: 'agora.run', value: { runId: 'lib', threadId: 't1' } }],
        [1, { type: 'STEP_STARTED', stepName: 'step-1' }],
        [
          2,
          {
            type: 'TOOL_CALL_START',
            toolCallId: 'c',
            toolCallName: 'refund',
            metadata: { 'agora.toolKind': 'action' },
          },
        ],
        [2, { type: 'TOOL_CALL_ARGS', toolCallId: 'c', delta: '{"id":7}' }],
        [2, { type: 'TOOL_CALL_END', toolCallId: 'c' }],
        [
          3,
          {
            type: 'CUSTOM',
            name: 'agora.approval-requested',
            value: {
              id: 'c',
              runId: 'lib',
              toolName: 'refund',
              input: { id: 7 },
              approver: 'requester',
            },
          },
        ],
        [3, { type: 'STEP_FINISHED', stepName: 'step-1' }],
        [
          3,
          {
            type: 'RUN_FINISHED',
            threadId: 't1',
            runId: 'r1',
            outcome: {
              type: 'interrupt',
              interrupts: [{ id: 'i1', reason: 'tool_approval', toolCallId: 'c' }],
            },
          },
        ],
      ]),
      [
        // What the native route streams after `?after=3` once the person approves.
        [
          'event: meta\ndata: {"runId":"lib","threadId":"t1"}\n\n',
          `id: 4\ndata: ${JSON.stringify({ kind: 'approval-settled', id: 'c', approved: true })}\n\n`,
          `id: 5\ndata: ${JSON.stringify({ kind: 'tool-output', id: 'c', output: { refunded: true } })}\n\n`,
          `id: 6\ndata: ${JSON.stringify({ kind: 'step-start' })}\n\n`,
          `id: 7\ndata: ${JSON.stringify({ kind: 'text', text: 'Done.' })}\n\n`,
          `id: 8\ndata: ${JSON.stringify({ kind: 'step-finish' })}\n\n`,
          'event: done\ndata: {}\n\n',
        ].join(''),
      ],
    );
    const transport = new AgentChatTransport({ backend, reconnect: { baseDelayMs: 1 } });
    const chunks = await collect(await transport.sendMessages(sendArgs()));

    expect(backend.resumed).toEqual([expect.objectContaining({ runId: 'lib', after: 3 })]);
    // One message: the card, then what the run did after the decision.
    expect(chunks.filter((chunk) => chunk.type === 'start')).toHaveLength(1);
    expect(chunks).toContainEqual(
      expect.objectContaining({ type: 'tool-output-available', toolCallId: 'c' }),
    );
    expect(chunks).toContainEqual(expect.objectContaining({ type: 'text-delta', delta: 'Done.' }));
    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'tool-input-available',
        toolCallId: 'c',
        toolMetadata: { toolKind: 'action' },
      }),
    );
    // The approval card is not drawn a second time as an AgUiInterrupt component.
    expect(JSON.stringify(chunks)).not.toContain('AgUiInterrupt');
    expect(chunks.at(-1)).toMatchObject({ type: 'finish' });
  });

  it('answers a text decision with the transient data-proposal-decision part', async () => {
    const decision = { status: 'approved', proposalId: 'p1' };
    const backend = backendWith(
      agUi([
        [undefined, { type: 'RUN_STARTED', threadId: 't1', runId: 'r1' }],
        [
          undefined,
          {
            type: 'CUSTOM',
            name: 'agora.action-proposal-decision',
            value: { threadId: 't1', proposalDecision: decision },
          },
        ],
        [undefined, { type: 'TEXT_MESSAGE_START', messageId: 'm', role: 'assistant' }],
        [undefined, { type: 'TEXT_MESSAGE_CONTENT', messageId: 'm', delta: 'Approved.' }],
        [undefined, { type: 'TEXT_MESSAGE_END', messageId: 'm' }],
        [undefined, { type: 'RUN_FINISHED', threadId: 't1', runId: 'r1' }],
      ]),
      [],
    );
    const transport = new AgentChatTransport({ backend });
    const chunks = await collect(await transport.sendMessages(sendArgs()));
    expect(chunks).toContainEqual({
      type: 'data-proposal-decision',
      data: { threadId: 't1', proposalDecision: decision, text: 'Approved.' },
      transient: true,
    });
    expect(backend.resumed).toEqual([]);
  });
});
