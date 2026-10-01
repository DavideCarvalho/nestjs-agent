// @vitest-environment jsdom
import type { AgentCatalogEntry, ThreadDetail } from '@dudousxd/nestjs-agent-core';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentBackend } from './backend.js';
import { useAgents } from './catalog/use-agents.js';
import { storedMessageToUiMessage } from './stored-message-to-ui-message.js';
import { storedThreadToUiMessages } from './stored-thread-to-ui-messages.js';
import { useAgentChat } from './use-agent-chat.js';

const AGENTS: AgentCatalogEntry[] = [
  {
    name: 'assistant',
    description: '',
    isDefault: true,
    defaultPersona: 'general',
    personas: [
      { id: 'general', label: 'General' },
      { id: 'sql', label: 'SQL focused', description: 'Writes the query first' },
    ],
  },
  { name: 'matcher', description: 'matches units' },
];

function backend(overrides: Partial<AgentBackend> = {}): AgentBackend {
  const encoder = new TextEncoder();
  return {
    openChatStream: vi.fn(async () => ({
      runId: 'run-1',
      threadId: 'thr-1',
      body: new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            encoder.encode('event: meta\ndata: {"runId":"run-1","threadId":"thr-1"}\n\n'),
          );
          controller.enqueue(encoder.encode('event: done\ndata: {}\n\n'));
          controller.close();
        },
      }),
    })),
    resumeChatStream: async () => null,
    cancelStream: async () => ({}),
    listThreads: async () => [],
    getThread: async () => {
      throw new Error('unused');
    },
    updateThread: vi.fn(async () => ({ ok: true })),
    deleteThread: async () => undefined,
    listAgents: async () => AGENTS,
    ...overrides,
  };
}

describe('useAgents — personas', () => {
  it('reads an agent’s personas and default, the default agent’s when none is named', async () => {
    const { result } = renderHook(() => useAgents({ backend: backend() }));
    await waitFor(() => expect(result.current.agents).toHaveLength(2));
    expect(result.current.personasOf().map((persona) => persona.id)).toEqual(['general', 'sql']);
    expect(result.current.personasOf('assistant')[1]).toEqual({
      id: 'sql',
      label: 'SQL focused',
      description: 'Writes the query first',
    });
    expect(result.current.defaultPersonaOf()).toBe('general');
    expect(result.current.personasOf('matcher')).toEqual([]);
    expect(result.current.defaultPersonaOf('matcher')).toBeNull();
  });
});

describe('useAgentChat — persona', () => {
  it('sends the persona picked at the time of each send, and mirrors the pin', async () => {
    const api = backend();
    const { result, rerender } = renderHook(
      (props: { persona?: string }) => useAgentChat({ backend: api, agent: 'assistant', ...props }),
      { initialProps: { persona: 'sql' } as { persona?: string } },
    );
    expect(result.current.threadPersona).toBeNull();
    await act(async () => {
      await result.current.sendMessage({ text: 'one' });
    });
    expect(result.current.threadPersona).toBe('sql');
    rerender({ persona: 'general' });
    await act(async () => {
      await result.current.sendMessage({ text: 'two' });
    });
    rerender({});
    await act(async () => {
      await result.current.sendMessage({ text: 'three' });
    });
    const bodies = vi.mocked(api.openChatStream).mock.calls.map(([request]) => request.body);
    expect(bodies.map((body) => [body.agent, body.persona])).toEqual([
      ['assistant', 'sql'],
      ['assistant', 'general'],
      // None picked: the server falls back to the thread's pin, so nothing is sent.
      ['assistant', undefined],
    ]);
    expect(result.current.threadPersona).toBe('general');
  });

  it('lets one send name its own persona', async () => {
    const api = backend();
    const { result } = renderHook(() => useAgentChat({ backend: api, persona: 'general' }));
    await act(async () => {
      await result.current.sendMessage({ text: 'once' }, { body: { persona: 'sql' } });
    });
    const [request] = vi.mocked(api.openChatStream).mock.calls[0] ?? [];
    expect(request?.body.persona).toBe('sql');
  });

  it('reads the thread’s pinned persona with its history', async () => {
    const thread: ThreadDetail = {
      id: 'thr-9',
      title: 'Old',
      transient: false,
      createdAt: '2026-09-01T00:00:00.000Z',
      updatedAt: '2026-09-01T00:00:00.000Z',
      persona: 'sql',
      activeRunId: null,
      messages: [],
    };
    const api = backend({ getThread: vi.fn(async () => thread) });
    const { result } = renderHook(() => useAgentChat({ backend: api, threadId: 'thr-9' }));
    await waitFor(() => expect(result.current.threadPersona).toBe('sql'));
  });
});

describe('the transcript says which persona answered', () => {
  it('carries agent and persona on a replayed message, and on a merged turn', () => {
    const one = storedMessageToUiMessage({
      id: 'm1',
      role: 'assistant',
      content: 'hi',
      agentName: 'assistant',
      persona: 'sql',
      createdAt: '2026-09-01T00:00:00.000Z',
    });
    expect(one.metadata).toMatchObject({ agentName: 'assistant', persona: 'sql' });

    const [, turn] = storedThreadToUiMessages([
      {
        id: 'u',
        role: 'user',
        content: 'q',
        persona: 'sql',
        createdAt: '2026-09-01T00:00:00.000Z',
      },
      {
        id: 'a1',
        role: 'assistant',
        content: 'checking',
        runId: 'r',
        agentName: 'assistant',
        persona: 'sql',
        createdAt: '2026-09-01T00:00:01.000Z',
      },
      {
        id: 'a2',
        role: 'assistant',
        content: 'done',
        runId: 'r',
        agentName: 'assistant',
        persona: 'sql',
        createdAt: '2026-09-01T00:00:02.000Z',
      },
    ]);
    expect(turn?.metadata).toMatchObject({ agentName: 'assistant', persona: 'sql' });
  });
});
