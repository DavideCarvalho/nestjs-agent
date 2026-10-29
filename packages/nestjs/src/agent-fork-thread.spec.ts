import type { AgentRunner } from '@dudousxd/nestjs-agent-core';
import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { AgentDepsFactory } from './agent-deps.factory.js';
import { AgentService } from './agent.service.js';

const runner: AgentRunner = {
  start: async () => ({ runId: 'run-1' }),
  signal: async () => undefined,
  cancel: async () => undefined,
};

const owner = { id: 'owner', tenantRef: 'tenant-1' };
const reader = { id: 'reader', tenantRef: 'tenant-2' };

async function seeded() {
  const store = new InMemoryAgentStore();
  const service = new AgentService(runner, store, {} as AgentDepsFactory);
  const thread = await store.createThread({ actor: owner });
  const first = await store.appendMessage({ threadId: thread.id, role: 'user', content: 'one' });
  await store.appendMessage({ threadId: thread.id, role: 'assistant', content: 'two' });
  return { store, service, threadId: thread.id, firstId: first.id };
}

describe('AgentService.forkThread', () => {
  it('is owner-only by default, and the copy is the owner’s', async () => {
    const { store, service, threadId, firstId } = await seeded();
    await expect(service.forkThread(reader, threadId, firstId)).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    const fork = await service.forkThread(owner, threadId, firstId);
    expect(await store.ownerOfThread(fork.id)).toBe('owner');
  });

  it('forks a thread the host authorized into the caller’s own copy, leaving the source alone', async () => {
    const { store, service, threadId, firstId } = await seeded();
    const fork = await service.forkThread(reader, threadId, firstId, { authorized: true });

    expect(await store.ownerOfThread(fork.id)).toBe('reader');
    expect((await store.getThread(fork.id))?.messages.map((m) => m.content)).toEqual(['one']);
    expect((await store.listThreads('reader')).map((t) => t.id)).toEqual([fork.id]);
    expect(await store.ownerOfThread(threadId)).toBe('owner');
    // The tenant is the source's unless the host says otherwise.
    expect((await store.getThreadActionProposalScope(fork.id))?.tenantRef).toBe('tenant-1');
  });

  it('passes the tenant through: a value sets it, null clears it', async () => {
    const { store, service, threadId, firstId } = await seeded();
    const moved = await service.forkThread(reader, threadId, firstId, {
      authorized: true,
      tenantRef: reader.tenantRef,
    });
    expect((await store.getThreadActionProposalScope(moved.id))?.tenantRef).toBe('tenant-2');
    const cleared = await service.forkThread(reader, threadId, firstId, {
      authorized: true,
      tenantRef: null,
    });
    expect((await store.getThreadActionProposalScope(cleared.id))?.tenantRef).toBeNull();
  });

  it('still 404s a thread that is not there, authorized or not', async () => {
    const { service } = await seeded();
    await expect(
      service.forkThread(reader, 'no-such-thread', 'm', { authorized: true }),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(service.forkThread(owner, 'no-such-thread', 'm')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
