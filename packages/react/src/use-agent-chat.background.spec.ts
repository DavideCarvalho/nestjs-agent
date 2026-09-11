// @vitest-environment jsdom
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { useAgentChat } from './use-agent-chat.js';

const receipt = {
  detached: true,
  status: 'started',
  agent: 'research',
  runId: 'run-child',
  note: 'working on it',
};

const delegation = {
  id: 'm2',
  role: 'assistant',
  content: 'starting the research agent',
  runId: 'run-parent',
  createdAt: '2026-09-11T00:00:00.000Z',
  toolCalls: [{ id: 'tc-1', name: 'ask_research', input: { task: 'dig' }, kind: 'agent' }],
  toolResults: [{ id: 'tc-1', name: 'ask_research', output: receipt }],
};

const answer = {
  id: 'm3',
  role: 'assistant',
  content: 'RESEARCH ANSWER',
  runId: 'run-child',
  agentName: 'research',
  createdAt: '2026-09-11T00:00:05.000Z',
};

function threadResponse(messages: unknown[]) {
  return {
    ok: true,
    status: 200,
    statusText: 'OK',
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => JSON.stringify({ id: 'thr-1', title: 'x', messages, activeRunId: null }),
  };
}

describe('useAgentChat background runs', () => {
  it('reports a sub-agent still working, then renders its answer without a reload', async () => {
    let landed = false;
    const fetchMock = vi.fn(async (url: string) => {
      if (url.includes('/agent/threads/thr-1')) {
        return threadResponse(landed ? [delegation, answer] : [delegation]);
      }
      return threadResponse([]);
    });

    const { result } = renderHook(() =>
      useAgentChat({
        threadId: 'thr-1',
        background: true,
        backgroundPollMs: 10,
        fetch: fetchMock as unknown as typeof fetch,
      }),
    );

    await waitFor(() => {
      expect(result.current.background.isWorking).toBe(true);
    });
    expect(result.current.background.runs[0]).toMatchObject({
      runId: 'run-child',
      agent: 'research',
      toolCallId: 'tc-1',
      status: 'running',
    });
    expect(result.current.messages).toHaveLength(0);

    // The detached run finishes somewhere else entirely; nothing tells this tab but the poll.
    act(() => {
      landed = true;
    });

    await waitFor(() => {
      expect(result.current.background.isWorking).toBe(false);
      expect(result.current.messages.map((message) => message.id)).toEqual(['m3']);
    });
  });

  it('stops polling once nothing is outstanding', async () => {
    const fetchMock = vi.fn(async (url: string) =>
      url.includes('/agent/threads/thr-1')
        ? threadResponse([delegation, answer])
        : threadResponse([]),
    );

    const { result } = renderHook(() =>
      useAgentChat({
        threadId: 'thr-1',
        background: true,
        backgroundPollMs: 5,
        fetch: fetchMock as unknown as typeof fetch,
      }),
    );

    await waitFor(() => expect(result.current.background.runs).toHaveLength(1));
    expect(result.current.background.isWorking).toBe(false);
    const after = fetchMock.mock.calls.length;
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(fetchMock.mock.calls.length).toBe(after);
  });
});
