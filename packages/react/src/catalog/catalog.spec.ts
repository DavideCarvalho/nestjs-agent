// @vitest-environment jsdom
import type { ModelCatalogView } from '@dudousxd/nestjs-agent-core';
import { act, renderHook, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { AgentBackend } from '../backend.js';
import { AgentClient } from '../client.js';
import { useAgentChat } from '../use-agent-chat.js';
import { useAgents } from './use-agents.js';
import { useModels } from './use-models.js';

const VIEW: ModelCatalogView = {
  default: 'fast',
  providers: [
    {
      id: 'openai',
      label: 'OpenAI',
      models: [
        { id: 'fast', label: 'Fast', badges: ['fast'], available: true },
        { id: 'pro', label: 'Pro', available: false, unavailableReason: 'plan' },
      ],
    },
    {
      id: 'anthropic',
      label: 'Anthropic',
      models: [{ id: 'sonnet', label: 'S', available: true }],
    },
  ],
};

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
    listModels: vi.fn(async () => VIEW),
    listAgents: async () => [
      { name: 'default', description: '', isDefault: true },
      { name: 'researcher', description: 'digs' },
    ],
    ...overrides,
  };
}

describe('useModels', () => {
  it('flattens the catalog, finds by id, and re-asks for another agent', async () => {
    const api = backend();
    const { result, rerender } = renderHook(
      (props: { agent?: string }) => useModels({ backend: api, ...props }),
      { initialProps: {} },
    );
    await waitFor(() => expect(result.current.models).toHaveLength(3));

    expect(result.current.defaultModel).toBe('fast');
    expect(result.current.find('pro')).toMatchObject({
      available: false,
      providerId: 'openai',
      providerLabel: 'OpenAI',
    });
    expect(result.current.find(null)).toBeUndefined();

    rerender({ agent: 'researcher' });
    await waitFor(() => expect(api.listModels).toHaveBeenLastCalledWith('researcher'));
  });

  it('reports a backend without listModels as an error', async () => {
    const { listModels: _omitted, ...api } = backend();
    const { result } = renderHook(() => useModels({ backend: api }));
    await waitFor(() => expect(result.current.error?.name).toBe('AgentBackendUnsupportedError'));
  });
});

describe('useAgents', () => {
  it('lists the agents and names the default', async () => {
    const { result } = renderHook(() => useAgents({ backend: backend() }));
    await waitFor(() => expect(result.current.agents).toHaveLength(2));
    expect(result.current.defaultAgent).toBe('default');
  });
});

describe('useAgentChat model selection', () => {
  it('sends the picked model on each turn and pins one on the thread', async () => {
    const api = backend();
    const { result, rerender } = renderHook(
      (props: { model?: string }) => useAgentChat({ backend: api, ...props }),
      { initialProps: { model: 'fast' } as { model?: string } },
    );
    await act(async () => {
      await result.current.sendMessage({ text: 'one' });
    });
    rerender({ model: 'sonnet' });
    await act(async () => {
      await result.current.sendMessage({ text: 'two' });
    });
    const bodies = vi.mocked(api.openChatStream).mock.calls.map(([request]) => request.body);
    expect(bodies.map((body) => body.model)).toEqual(['fast', 'sonnet']);
    expect(bodies[1]?.threadId).toBe('thr-1');

    await act(async () => {
      await result.current.models.pinToThread('sonnet');
    });
    expect(api.updateThread).toHaveBeenCalledWith('thr-1', { model: 'sonnet' });
  });

  it('chat.models loads lazily, and select() picks the model the next turns run on', async () => {
    const api = backend();
    const { result } = renderHook(() => useAgentChat({ backend: api }));
    await act(async () => {
      await Promise.resolve();
    });
    expect(api.listModels).not.toHaveBeenCalled();
    expect(result.current.models.list).toEqual([]);
    await waitFor(() => expect(result.current.models.list).toHaveLength(3));
    expect(result.current.models.selected).toBe('fast');
    act(() => result.current.models.select('sonnet'));
    expect(result.current.models.selected).toBe('sonnet');
    await act(async () => {
      await result.current.sendMessage({ text: 'hi' });
    });
    const body = vi.mocked(api.openChatStream).mock.calls[0]?.[0].body;
    expect(body?.model).toBe('sonnet');
  });

  it('a pin asked for before the first send lands on the thread that send creates', async () => {
    const api = backend();
    const { result } = renderHook(() => useAgentChat({ backend: api }));
    await act(async () => {
      await result.current.models.pinToThread('pro');
    });
    expect(api.updateThread).not.toHaveBeenCalled();
    await act(async () => {
      await result.current.sendMessage({ text: 'hi' });
    });
    await waitFor(() => expect(api.updateThread).toHaveBeenCalledWith('thr-1', { model: 'pro' }));
  });
});

describe("useAgentChat — a turn's model vs the thread's pin", () => {
  it('pinning replaces the pick: later sends leave the model to the pin', async () => {
    const api = backend({
      getThread: async (id) => ({
        id,
        title: 'T',
        transient: false,
        createdAt: 'x',
        updatedAt: 'x',
        model: null,
        messages: [],
      }),
    });
    const { result } = renderHook(() => useAgentChat({ backend: api, threadId: 'thr-1' }));
    await waitFor(() => expect(result.current.models.pinned).toBeNull());

    act(() => result.current.models.select('sonnet'));
    await act(async () => {
      await result.current.sendMessage({ text: 'one' });
    });
    await act(async () => {
      await result.current.models.pinToThread('fast');
    });
    expect(result.current.models.pinned).toBe('fast');
    expect(result.current.models.selected).toBe('fast');
    await act(async () => {
      await result.current.sendMessage({ text: 'two' });
    });

    const bodies = vi.mocked(api.openChatStream).mock.calls.map(([request]) => request.body);
    expect(bodies.map((body) => body.model)).toEqual(['sonnet', undefined]);
  });

  it('a pick belongs to the conversation it was made in', async () => {
    const thread = (id: string, model: string | null) => ({
      id,
      title: 'T',
      transient: false,
      createdAt: 'x',
      updatedAt: 'x',
      model,
      messages: [],
    });
    const api = backend({
      getThread: async (id) => thread(id, id === 'thr-2' ? 'pro' : null),
    });
    const { result, rerender } = renderHook(
      (props: { threadId: string }) => useAgentChat({ backend: api, ...props }),
      { initialProps: { threadId: 'thr-1' } },
    );
    act(() => result.current.models.select('sonnet'));
    expect(result.current.models.selected).toBe('sonnet');

    rerender({ threadId: 'thr-2' });
    await waitFor(() => expect(result.current.models.pinned).toBe('pro'));
    expect(result.current.models.selected).toBe('pro');
  });

  it('a locked agent: the picker reports the lock, selects it, and ignores picks', async () => {
    const api = backend({
      listModels: vi.fn(async () => ({
        ...VIEW,
        default: 'pro',
        locked: { model: 'pro', reason: 'This assistant always uses Pro' },
      })),
    });
    const { result } = renderHook(() => useAgentChat({ backend: api }));
    expect(result.current.models.list).toEqual([]);
    await waitFor(() =>
      expect(result.current.models.locked).toEqual({
        model: 'pro',
        reason: 'This assistant always uses Pro',
      }),
    );
    act(() => result.current.models.select('sonnet'));
    expect(result.current.models.selected).toBe('pro');
    await act(async () => {
      await result.current.sendMessage({ text: 'hi' });
    });
    expect(vi.mocked(api.openChatStream).mock.calls[0]?.[0].body.model).toBeUndefined();
  });
});

describe('useModels — a locked catalog', () => {
  it('exposes the lock', async () => {
    const api = backend({
      listModels: vi.fn(async () => ({ ...VIEW, locked: { model: 'fast' } })),
    });
    const { result } = renderHook(() => useModels({ backend: api }));
    await waitFor(() => expect(result.current.locked).toEqual({ model: 'fast' }));
  });
});

describe('AgentClient catalogs', () => {
  it('asks GET /agent/models?agent= and GET /agent/agents', async () => {
    const urls: string[] = [];
    const fetch = (async (url: string) => {
      urls.push(url);
      return { ok: true, status: 200, statusText: 'OK', text: async () => '[]' };
    }) as unknown as typeof globalThis.fetch;
    const client = new AgentClient({ fetch });
    await client.listModels('a b');
    await client.listModels();
    await client.listAgents();
    expect(urls).toEqual(['/agent/models?agent=a%20b', '/agent/models', '/agent/agents']);
  });
});
