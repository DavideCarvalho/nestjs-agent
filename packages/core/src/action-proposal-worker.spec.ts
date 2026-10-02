import { expect, it, vi } from 'vitest';
import { z } from 'zod';
import { ActionProposalExecutor } from './action-proposal-executor.js';
import { ActionProposalWorker } from './action-proposal-worker.js';
import { InMemoryAgentStore } from './in-memory-store.js';
import { DefaultRolesPolicy, ToolRegistry } from './tool-registry.js';

it('executes approved work once and admits a fact without starting a model run', async () => {
  const store = new InMemoryAgentStore({ clock: () => 1000 });
  await store.createThread({ id: 't', actor: { id: 'a' } });
  const input = {
    id: 'p',
    tenantRef: null,
    actorRef: 'a',
    threadId: 't',
    originRunId: 'r',
    originMessageId: 'm',
    originToolCallId: 'c',
    toolName: 'send',
    input: null,
    confirmation: { title: 'Send', verb: 'Send' },
    approver: 'requester',
    expiresAt: null,
    idempotencyKey: 'key',
  };
  await store.createActionProposal(input);
  await store.decideActionProposal(input, 'p', {
    decision: 'approved',
    actorRef: 'a',
    via: 'button',
  });
  let effects = 0;
  const registry = new ToolRegistry();
  registry.register(
    { name: 'send', kind: 'action', description: 'send', inputSchema: z.null() },
    {
      execute: async () => {
        effects++;
        return 'sent';
      },
    },
  );
  const executor = new ActionProposalExecutor({
    resolver: { resolve: async () => ({ id: 'a' }) },
    resolveExecution: async () => ({ registry, rolesPolicy: new DefaultRolesPolicy() }),
  });
  const worker = new ActionProposalWorker({ store, executor, workerId: 'w' });
  await worker.runOnce();
  await worker.runOnce();
  expect(effects).toBe(1);
  expect((await store.getThread('t'))?.messages).toHaveLength(1);
  expect((await store.getActionProposal(input, 'p'))?.outcomeDelivery?.status).toBe('admitted');
  await worker.stop();
});
it('validates lease and polling configuration before scheduling', () => {
  const store = new InMemoryAgentStore();
  const executor = new ActionProposalExecutor({
    resolver: { resolve: async () => null },
    resolveExecution: async () => {
      throw new Error('unused');
    },
  });
  expect(
    () =>
      new ActionProposalWorker({ store, executor, workerId: 'w', leaseMs: 30, pollIntervalMs: 10 }),
  ).toThrow();
});
it('renews an in-flight action and loses settlement authority when a newer fence wins', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  try {
    const store = new InMemoryAgentStore({ clock: Date.now });
    await store.createThread({ id: 't', actor: { id: 'a' } });
    const input = {
      id: 'p',
      tenantRef: null,
      actorRef: 'a',
      threadId: 't',
      originRunId: 'r',
      originMessageId: 'm',
      originToolCallId: 'c',
      toolName: 'send',
      input: null,
      confirmation: { title: 'Send', verb: 'Send' },
      approver: 'requester',
      expiresAt: null,
      idempotencyKey: 'key',
    };
    await store.createActionProposal(input);
    await store.decideActionProposal(input, 'p', {
      decision: 'approved',
      actorRef: 'a',
      via: 'button',
    });
    let release: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = new ToolRegistry();
    registry.register(
      { name: 'send', kind: 'action', description: 'send', inputSchema: z.null() },
      {
        execute: async () => {
          await waiting;
          return 'sent';
        },
      },
    );
    const executor = new ActionProposalExecutor({
      resolver: { resolve: async () => ({ id: 'a' }) },
      resolveExecution: async () => ({ registry, rolesPolicy: new DefaultRolesPolicy() }),
    });
    const worker = new ActionProposalWorker({
      store,
      executor,
      workerId: 'w',
      leaseMs: 90,
      pollIntervalMs: 10,
    });
    const running = worker.runOnce();
    await vi.advanceTimersByTimeAsync(100);
    expect(await store.claimNextActionProposal({ workerId: 'peer', leaseMs: 90 })).toBeNull();
    release();
    await running;
    expect((await store.getActionProposal(input, 'p'))?.execution?.status).toBe('succeeded');
    await worker.stop();
  } finally {
    vi.useRealTimers();
  }
});
it('stops lease renewal on shutdown and cannot settle after that lease expires', async () => {
  vi.useFakeTimers();
  vi.setSystemTime(1000);
  try {
    const store = new InMemoryAgentStore({ clock: Date.now });
    await store.createThread({ id: 't', actor: { id: 'a' } });
    const input = {
      id: 'p',
      tenantRef: null,
      actorRef: 'a',
      threadId: 't',
      originRunId: 'r',
      originMessageId: 'm',
      originToolCallId: 'c',
      toolName: 'send',
      input: null,
      confirmation: { title: 'Send', verb: 'Send' },
      approver: 'requester',
      expiresAt: null,
      idempotencyKey: 'key',
    };
    await store.createActionProposal(input);
    await store.decideActionProposal(input, 'p', {
      decision: 'approved',
      actorRef: 'a',
      via: 'button',
    });
    let release: () => void = () => {};
    const waiting = new Promise<void>((resolve) => {
      release = resolve;
    });
    const registry = new ToolRegistry();
    registry.register(
      { name: 'send', kind: 'action', description: 'send', inputSchema: z.null() },
      {
        execute: async () => {
          await waiting;
          return 'sent';
        },
      },
    );
    const renew = vi.spyOn(store, 'extendActionProposalLease');
    const executor = new ActionProposalExecutor({
      resolver: { resolve: async () => ({ id: 'a' }) },
      resolveExecution: async () => ({ registry, rolesPolicy: new DefaultRolesPolicy() }),
    });
    const worker = new ActionProposalWorker({
      store,
      executor,
      workerId: 'w',
      leaseMs: 90,
      pollIntervalMs: 10,
    });
    const running = worker.runOnce();
    await vi.advanceTimersByTimeAsync(1);
    const stopped = worker.stop();
    await vi.advanceTimersByTimeAsync(100);
    expect(renew).not.toHaveBeenCalled();
    release();
    await stopped;
    await running;
    expect((await store.getActionProposal(input, 'p'))?.outcome).toBeUndefined();
  } finally {
    vi.useRealTimers();
  }
});
