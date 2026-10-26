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

const deps = {
  defaultAgentName: () => 'module-default',
  resolveAgent: (agentName: string) => ({ agentName }),
  personaCatalog: () => [],
  resolvePersona: () => undefined,
} as unknown as AgentDepsFactory;

function buildService(store: AgentStore): AgentService {
  return new AgentService(runner, store, deps);
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
    const store = Object.create(backing) as AgentStore & {
      defaultAgentForThread?: unknown;
      threadSettings?: unknown;
    };
    store.defaultAgentForThread = undefined;
    store.threadSettings = undefined;
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

describe('AgentService — what a send reads off its thread', () => {
  const THREAD_READS = [
    'getThread',
    'ownerOfThread',
    'defaultAgentForThread',
    'personaForThread',
    'modelForThread',
    'threadSettings',
  ] as const;

  it('reads the thread once for its owner, default agent, persona and model', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: { id: 'u1' } });
    await store.updateThread(thread.id, { defaultAgent: 'researcher', persona: 'pirate' });
    const reads = THREAD_READS.map((name) => vi.spyOn(store, name));
    const updateThread = vi.spyOn(store, 'updateThread');
    const start = vi.spyOn(runner, 'start');
    const service = new AgentService(runner, store, {
      ...deps,
      personaCatalog: () => [{ id: 'pirate' }, { id: 'clerk' }],
      resolvePersona: ({
        requested,
        threadPersona,
      }: { requested?: string; threadPersona?: string }) => requested ?? threadPersona,
    } as unknown as AgentDepsFactory);

    await service.chat({ actor: { id: 'u1' }, message: 'hi', threadId: thread.id });
    await service.chat({
      actor: { id: 'u1' },
      message: 'again',
      threadId: thread.id,
      personaId: 'clerk',
    });

    expect(start.mock.calls.map(([input]) => [input.agentName, input.persona])).toEqual([
      ['researcher', 'pirate'],
      ['researcher', 'clerk'],
    ]);
    // The persona a send names is pinned, compared against the one read.
    expect(updateThread).toHaveBeenCalledWith(thread.id, { persona: 'clerk' });
    const calls = reads.reduce((sum, spy) => sum + spy.mock.calls.length, 0);
    expect(calls).toBe(2);
    for (const spy of [...reads, updateThread, start]) spy.mockRestore();
  });

  it("refuses another actor's thread off the same read", async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: { id: 'owner' } });
    await expect(
      buildService(store).chat({ actor: { id: 'intruder' }, message: 'hi', threadId: thread.id }),
    ).rejects.toThrow('thread belongs to another actor');
    await expect(
      buildService(store).chat({ actor: { id: 'owner' }, message: 'hi', threadId: 'missing' }),
    ).rejects.toThrow('thread missing not found');
  });
});
