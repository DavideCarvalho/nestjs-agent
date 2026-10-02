import { FakeModelProvider, InMemoryTokenStreamSink } from '@dudousxd/nestjs-agent-testing';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { type AgentLoopDeps, runAgentLoop } from './agent-loop.js';
import { InMemoryAgentStore } from './in-memory-store.js';
import { ToolRegistry } from './tool-registry.js';
import { DefaultRolesPolicy } from './tool-registry.js';

it('finishes the batch with a normalized pending receipt, no approval wait, effect or next model turn', async () => {
  const store = new InMemoryAgentStore();
  const actor = { id: 'a', roles: ['ADMIN'] };
  const thread = await store.createThread({ actor });
  const registry = new ToolRegistry();
  let effects = 0;
  let preparations = 0;
  registry.register(
    {
      name: 'send',
      kind: 'action',
      terminal: true,
      description: 'send',
      inputSchema: z.object({ amount: z.number().default(5) }),
    },
    {
      preflight: (input) => {
        preparations++;
        return {
          status: 'ready',
          confirmation: {
            title: `Send ${z.object({ amount: z.number() }).parse(input).amount}`,
            verb: 'Send',
          },
        };
      },
      execute: async () => {
        effects++;
        return 'sent';
      },
    },
  );
  let calls = 0;
  const model = new FakeModelProvider(() => {
    calls++;
    return { text: 'Preparing', toolCall: { name: 'send', input: {} } };
  });
  const sink = new InMemoryTokenStreamSink();
  const deps: AgentLoopDeps = {
    store,
    registry,
    model,
    rolesPolicy: new DefaultRolesPolicy(),
    systemPrompt: 'test',
    day: '2026-10-01',
    actionApprovalMode: 'independent',
  };
  let waits = 0;
  await runAgentLoop(
    deps,
    { threadId: thread.id, actor, userText: 'send' },
    {
      runId: 'r',
      openSink: () => sink.open('r'),
      step: (_name, fn) => fn(),
      awaitApproval: async () => {
        waits++;
        return { approved: true };
      },
    },
  );
  expect({ calls, waits, effects, preparations }).toEqual({
    calls: 1,
    waits: 0,
    effects: 0,
    preparations: 1,
  });
  const proposals = await store.listActionProposals({
    threadId: thread.id,
    tenantRef: null,
    actorRef: actor.id,
  });
  expect(proposals).toHaveLength(1);
  expect(proposals[0]).toMatchObject({
    input: { amount: 5 },
    preparationInput: {},
    confirmation: { title: 'Send 5' },
    decision: 'pending',
  });
  expect(required(required(await store.getThread(thread.id)).messages.at(-1)).toolResults).toEqual([
    expect.objectContaining({
      output: { proposalId: required(proposals[0]).id, status: 'pending', executed: false },
    }),
  ]);
});

it.each(['auto', 'remembered'] as const)(
  'preserves transformed Date arguments for %s approval in independent mode',
  async (mode) => {
    const store = new InMemoryAgentStore();
    const actor = { id: 'actor', roles: ['ADMIN'] };
    const thread = await store.createThread({ actor });
    if (mode === 'remembered') {
      const scope = { actorRef: actor.id, tenantRef: null, threadId: thread.id };
      await store.createActionProposal({
        ...scope,
        id: 'previous',
        originRunId: 'old',
        originMessageId: 'old-message',
        originToolCallId: 'old-call',
        toolName: 'schedule',
        input: null,
        confirmation: { title: 'Schedule?', verb: 'Schedule' },
        approver: 'requester',
        expiresAt: null,
        idempotencyKey: 'previous',
      });
      await store.decideActionProposal(scope, 'previous', {
        decision: 'approved',
        actorRef: actor.id,
        via: 'button',
        remember: true,
      });
      const claimed = await store.claimActionProposal(scope, 'previous', {
        workerId: 'worker',
        leaseMs: 30000,
      });
      const lease = required(required(required(claimed.proposal).execution).lease);
      await store.settleActionProposal(scope, 'previous', {
        token: lease.token,
        generation: lease.generation,
        status: 'succeeded',
      });
    }
    const registry = new ToolRegistry();
    let executed: Date | undefined;
    registry.register(
      {
        name: 'schedule',
        kind: 'action',
        terminal: true,
        description: 'schedule',
        inputSchema: z.object({ at: z.string().transform((value) => new Date(value)) }),
      },
      {
        execute: async (input) => {
          executed = z.object({ at: z.date() }).parse(input).at;
          return 'scheduled';
        },
      },
    );
    const model = new FakeModelProvider(() => ({
      text: 'Scheduling',
      toolCall: { name: 'schedule', input: { at: '2026-10-01T12:00:00Z' } },
    }));
    const sink = new InMemoryTokenStreamSink();
    const deps: AgentLoopDeps = {
      store,
      registry,
      model,
      rolesPolicy: new DefaultRolesPolicy(),
      systemPrompt: 'test',
      day: '2026-10-01',
      actionApprovalMode: 'independent',
      ...(mode === 'auto'
        ? { approvalPolicy: { requirementFor: () => ({ required: false, approver: 'requester' }) } }
        : {}),
    };
    let waits = 0;
    await runAgentLoop(
      deps,
      { threadId: thread.id, actor, userText: 'schedule' },
      {
        runId: 'new-run',
        openSink: () => sink.open('new-run'),
        step: (_name, fn) => fn(),
        awaitApproval: async () => {
          waits++;
          return { approved: true };
        },
      },
    );
    expect(executed).toBeInstanceOf(Date);
    expect(executed?.toISOString()).toBe('2026-10-01T12:00:00.000Z');
    expect(waits).toBe(0);
    expect(
      (
        await store.listActionProposals({
          actorRef: actor.id,
          tenantRef: null,
          threadId: thread.id,
        })
      ).filter((row) => row.originRunId === 'new-run'),
    ).toHaveLength(0);
  },
);

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected a persisted proposal, lease or message');
  return value;
}
