// @vitest-environment jsdom
import type { ActionProposalView, StoredMessage, ThreadDetail } from '@dudousxd/nestjs-agent-core';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentBackend, ResumeStreamRequest } from './backend.js';
import { useAgentChat } from './use-agent-chat.js';

const encoder = new TextEncoder();

function stream(frames: string[]) {
  let index = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const frame = frames[index];
      index += 1;
      if (frame === undefined) controller.close();
      else controller.enqueue(encoder.encode(frame));
    },
  });
}

const frame = (id: number, event: object) => `id: ${id}\ndata: ${JSON.stringify(event)}\n\n`;
const DONE = 'event: done\ndata: {}\n\n';

const stored = (id: string, role: 'user' | 'assistant', content: string): StoredMessage =>
  ({ id, role, content, createdAt: '2026-10-11T00:00:00.000Z' }) as StoredMessage;

const pending = {
  id: 'p',
  threadId: 'thr-1',
  originToolCallId: 'c',
  decision: 'pending',
  execution: null,
} as unknown as ActionProposalView;
const admitted = {
  ...pending,
  decision: 'approved',
  execution: { status: 'succeeded', generation: 1, lease: null },
  outcomeDelivery: { status: 'admitted', generation: 1, lease: null, messageId: 'fact' },
} as unknown as ActionProposalView;

interface Server {
  backend: AgentBackend;
  resumed: ResumeStreamRequest[];
  state: {
    proposals: ActionProposalView[];
    activeRunId: string | null;
    messages: StoredMessage[];
  };
}

function server(): Server {
  const resumed: ResumeStreamRequest[] = [];
  const state: Server['state'] = {
    proposals: [pending],
    activeRunId: null,
    messages: [stored('m1', 'user', 'order boots'), stored('m2', 'assistant', 'Sign in first.')],
  };
  const backend: AgentBackend = {
    openChatStream: async () => {
      throw new Error('no send in these specs');
    },
    async resumeChatStream(request) {
      resumed.push(request);
      // What the run writes to the thread as it streams.
      state.activeRunId = null;
      state.messages = [
        ...state.messages,
        stored('m3', 'user', 'Connected. Go on.'),
        stored('m4', 'assistant', 'Signed in — ordering now.'),
      ];
      return {
        body: stream([frame(1, { kind: 'text', text: 'Signed in — ordering now.' }), DONE]),
      };
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
        messages: state.messages,
        activeRunId: state.activeRunId,
      } as ThreadDetail;
    },
    updateThread: vi.fn(async () => ({ ok: true })),
    deleteThread: vi.fn(async () => undefined),
    listActionProposals: async () => state.proposals,
  };
  return { backend, resumed, state };
}

describe('useAgentChat — a turn the server started', () => {
  it('a newly admitted outcome follows the turn the server continued from it', async () => {
    const { backend, resumed, state } = server();
    const { result } = renderHook(() =>
      useAgentChat({ backend, threadId: 'thr-1', proposalPollMs: 0 }),
    );
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    await waitFor(() => expect(result.current.proposals.items).toEqual([pending]));
    expect(resumed).toEqual([]);

    // The sign-in completed elsewhere: the connect ran, and the server went on with a new turn.
    state.proposals = [admitted];
    state.activeRunId = 'run-2';
    await act(async () => {
      await result.current.proposals.refresh();
    });
    await waitFor(() => expect(resumed.map((request) => request.runId)).toEqual(['run-2']));
    // Streamed, then shown as stored — the continued turn's own user message included.
    await waitFor(() =>
      expect(result.current.messages.map((message) => message.id)).toEqual([
        'm1',
        'm2',
        'm3',
        'm4',
      ]),
    );
    expect(result.current.activeRunId).toBe('run-2');
  });

  it('followServerTurn shows the stored thread when the server turn is already over', async () => {
    const { backend, resumed, state } = server();
    const { result } = renderHook(() =>
      useAgentChat({ backend, threadId: 'thr-1', proposals: false }),
    );
    await waitFor(() => expect(result.current.messages).toHaveLength(2));
    // The continued turn ran and finished before this chat looked.
    state.messages = [
      ...state.messages,
      stored('m3', 'user', 'Connected. Go on.'),
      stored('m4', 'assistant', 'Your boots are ordered.'),
    ];
    await act(async () => {
      await result.current.followServerTurn();
    });
    expect(resumed).toEqual([]);
    expect(result.current.messages.map((message) => message.id)).toEqual(['m1', 'm2', 'm3', 'm4']);
  });
});
