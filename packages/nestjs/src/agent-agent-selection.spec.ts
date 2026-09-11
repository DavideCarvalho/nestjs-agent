import type { AgentRunner, AgentStore } from '@dudousxd/nestjs-agent-core';
import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it, vi } from 'vitest';
import type { AgentDepsFactory } from './agent-deps.factory.js';
import { AgentService } from './agent.service.js';

const runner: AgentRunner = {
  start: async () => ({ runId: 'run-1' }),
  signal: async () => undefined,
  cancel: async () => undefined,
};

const deps = { defaultAgentName: () => 'module-default' } as unknown as AgentDepsFactory;

function buildService(store: AgentStore): AgentService {
  return new AgentService(runner, store, deps, undefined);
}

describe('AgentService — picking the agent for a turn', () => {
  it("uses the thread's default agent without reading the thread", async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: { id: 'u1' } });
    await store.updateThread(thread.id, { defaultAgent: 'researcher' });
    await store.appendMessage({ threadId: thread.id, role: 'user', content: 'x'.repeat(50_000) });
    const getThread = vi.spyOn(store, 'getThread');
    const start = vi.spyOn(runner, 'start');

    await buildService(store).chat({ actor: { id: 'u1' }, message: 'hi', threadId: thread.id });

    expect(start.mock.calls[0]?.[0]?.agentName).toBe('researcher');
    // the whole transcript is read, and discarded, for one nullable scalar
    expect(getThread).not.toHaveBeenCalled();
    getThread.mockRestore();
    start.mockRestore();
  });

  it('falls back to the module default, still without reading the thread', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: { id: 'u1' } });
    const getThread = vi.spyOn(store, 'getThread');
    const start = vi.spyOn(runner, 'start');

    await buildService(store).chat({ actor: { id: 'u1' }, message: 'hi', threadId: thread.id });

    expect(start.mock.calls[0]?.[0]?.agentName).toBe('module-default');
    expect(getThread).not.toHaveBeenCalled();
    getThread.mockRestore();
    start.mockRestore();
  });

  it('reads the thread only when the store cannot project the field', async () => {
    const backing = new InMemoryAgentStore();
    const thread = await backing.createThread({ actor: { id: 'u1' } });
    await backing.updateThread(thread.id, { defaultAgent: 'researcher' });
    // a store predating the projection: everything else delegates, the projection is simply absent
    const store = Object.create(backing) as AgentStore & { defaultAgentForThread?: unknown };
    store.defaultAgentForThread = undefined;
    const start = vi.spyOn(runner, 'start');

    await buildService(store).chat({ actor: { id: 'u1' }, message: 'hi', threadId: thread.id });

    expect(start.mock.calls[0]?.[0]?.agentName).toBe('researcher');
    start.mockRestore();
  });

  it('never asks the store at all when the caller named an agent', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: { id: 'u1' } });
    await store.updateThread(thread.id, { defaultAgent: 'researcher' });
    const projected = vi.spyOn(store, 'defaultAgentForThread');
    const start = vi.spyOn(runner, 'start');

    await buildService(store).chat({
      actor: { id: 'u1' },
      message: 'hi',
      threadId: thread.id,
      agentName: 'explicit',
    });

    expect(start.mock.calls[0]?.[0]?.agentName).toBe('explicit');
    expect(projected).not.toHaveBeenCalled();
    projected.mockRestore();
    start.mockRestore();
  });
});
