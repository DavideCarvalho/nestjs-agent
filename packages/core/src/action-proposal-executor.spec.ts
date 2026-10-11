import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { ActionProposalExecutor } from './action-proposal-executor.js';
import { InMemoryActionProposalStore } from './in-memory-action-proposal-store.js';
import { PERSONAL_AGENT_ROLE, personalAgentGate, scopeRole } from './personal-agent.js';
import { DefaultRolesPolicy, ToolRegistry } from './tool-registry.js';

it('runs as fresh requester with raw transformation once and collects late UI under the stable key', async () => {
  const store = new InMemoryActionProposalStore({ clock: () => 1000 });
  const input = {
    id: 'p',
    tenantRef: null,
    actorRef: 'a',
    threadId: 't',
    originRunId: 'r',
    originMessageId: 'm',
    originToolCallId: 'c',
    toolName: 'send',
    input: { value: 2 },
    preparationInput: { value: 1 },
    executionContext: { requestId: 'req' },
    confirmation: { title: 'Send', verb: 'Send' },
    approver: 'requester',
    expiresAt: null,
    idempotencyKey: 'stable',
  };
  await store.createActionProposal(input);
  await store.decideActionProposal(input, 'p', {
    decision: 'approved',
    actorRef: 'reviewer',
    via: 'button',
  });
  const claim = await store.claimActionProposal(input, 'p', { workerId: 'w', leaseMs: 100 });
  const registry = new ToolRegistry();
  let transforms = 0;
  registry.register(
    {
      name: 'send',
      kind: 'action',
      description: 'send',
      inputSchema: z.object({
        value: z.number().transform((value) => {
          transforms++;
          return value + 1;
        }),
      }),
    },
    {
      execute: async (data, ctx) => {
        expect(ctx.actor.id).toBe('a');
        expect(ctx.idempotencyKey).toBe('stable');
        await ctx.emitUi('note', { text: 'Sent' });
        return data;
      },
    },
  );
  const executor = new ActionProposalExecutor({
    resolver: { resolve: async () => ({ id: 'a', roles: ['ADMIN'] }) },
    resolveExecution: async () => ({ registry, rolesPolicy: new DefaultRolesPolicy() }),
  });
  const result = await executor.execute(required(claim.proposal));
  expect(result).toMatchObject({
    status: 'succeeded',
    result: { value: 2 },
    ui: [{ component: 'note', props: { text: 'Sent' } }],
  });
  expect(transforms).toBe(1);
});

it('fails fresh requester scope mismatch before resolving handlers', async () => {
  const executor = new ActionProposalExecutor({
    resolver: { resolve: async () => ({ id: 'reviewer' }) },
    resolveExecution: async () => {
      throw new Error('must not resolve');
    },
  });
  const store = new InMemoryActionProposalStore();
  const create = await store.createActionProposal({
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
  });
  expect(await executor.execute(required(create.proposal))).toMatchObject({
    status: 'failed',
    error: expect.stringContaining('requester'),
  });
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected fixture value');
  return value;
}

describe('a personal agent’s proposal runs under the roles it was proposed with', () => {
  async function approvedProposal(personalAgentRoles: string[]) {
    const store = new InMemoryActionProposalStore({ clock: () => 1000 });
    const input = {
      id: 'p',
      tenantRef: null,
      actorRef: 'acct-1',
      threadId: 't',
      originRunId: 'r',
      originMessageId: 'm',
      originToolCallId: 'c',
      toolName: 'cancel_order',
      input: { id: 'A-1' },
      executionContext: { requestId: 'req', personalAgentRoles },
      confirmation: { title: 'Cancel order', verb: 'Cancel' },
      approver: 'requester',
      expiresAt: null,
      idempotencyKey: 'stable',
    };
    await store.createActionProposal(input);
    await store.decideActionProposal(input, 'p', {
      decision: 'approved',
      actorRef: 'acct-1',
      via: 'poppy',
    });
    const claim = await store.claimActionProposal(input, 'p', { workerId: 'w', leaseMs: 100 });
    return required(claim.proposal);
  }

  function deployment() {
    const ran: unknown[] = [];
    const registry = new ToolRegistry();
    registry.register(
      {
        name: 'cancel_order',
        kind: 'action',
        description: 'cancel',
        inputSchema: z.object({ id: z.string() }),
        roles: [scopeRole('poppy:write')],
      },
      {
        execute: async (data, ctx) => {
          ran.push({ data, roles: ctx.actor.roles });
          return { cancelled: true };
        },
      },
    );
    const executor = new ActionProposalExecutor({
      // The background resolver answers the WHOLE account, with app roles of its own.
      resolver: { resolve: async () => ({ id: 'acct-1', roles: ['ADMIN', 'member'] }) },
      resolveExecution: async () => ({
        registry,
        // The app's own policy lets the account do anything; only the gate stands in the way.
        rolesPolicy: personalAgentGate({ can: () => true }),
      }),
    });
    return { executor, ran };
  }

  it('a read-only session’s proposal of a write tool does not execute after approval', async () => {
    const { executor, ran } = deployment();
    const result = await executor.execute(
      await approvedProposal([PERSONAL_AGENT_ROLE, scopeRole('poppy:read')]),
    );
    expect(result.status).toBe('failed');
    expect(ran).toEqual([]);
  });

  it('runs with the granted scope, as the agent and not as the account', async () => {
    const { executor, ran } = deployment();
    const result = await executor.execute(
      await approvedProposal([PERSONAL_AGENT_ROLE, scopeRole('poppy:write')]),
    );
    expect(result.status).toBe('succeeded');
    expect(ran).toEqual([
      { data: { id: 'A-1' }, roles: [PERSONAL_AGENT_ROLE, scopeRole('poppy:write')] },
    ]);
  });
});
