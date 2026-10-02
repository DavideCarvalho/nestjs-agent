import type {
  ActionProposalOutcomeStore,
  ActionProposalScope,
  CreateActionProposal,
} from '@dudousxd/nestjs-agent-core';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { DrizzleAgentStore } from './drizzle-agent-store.js';
import { type AgentDbHandle, describeEachDialect, openAgentDb } from './testing/real-db.js';

describeEachDialect('Drizzle independent outcome admission', (dialect) => {
  let handle: AgentDbHandle;
  let now = 1000;
  let intercept: ((query: string) => void) | undefined;
  beforeAll(async () => {
    handle = await openAgentDb(dialect, {
      logger: {
        logQuery: (query) => {
          intercept?.(query);
        },
      },
    });
  });
  afterAll(async () => {
    await handle?.close();
  });
  beforeEach(async () => {
    intercept = undefined;
    await handle.run('delete from agent_action_proposal');
    await handle.run('delete from agent_message');
    await handle.run('delete from agent_thread');
    now = 1000;
  });
  const scope: ActionProposalScope = { tenantRef: 'tenant', actorRef: 'actor', threadId: 'thread' };
  function store() {
    return new DrizzleAgentStore(handle.db, { clock: () => now });
  }
  async function setup() {
    const source = store();
    await source.createThread({
      id: 'thread',
      actor: { id: 'actor', roles: [], tenantRef: 'tenant' },
    });
    const input: CreateActionProposal = {
      ...scope,
      id: 'proposal',
      originRunId: 'run',
      originMessageId: 'message',
      originToolCallId: 'call',
      toolName: 'refund',
      input: { amount: 12 },
      confirmation: { title: 'Refund?', verb: 'Refund' },
      approver: 'actor',
      expiresAt: null,
      idempotencyKey: 'stable',
    };
    await source.createActionProposal(input);
    await source.decideActionProposal(scope, input.id, {
      decision: 'rejected',
      actorRef: 'actor',
      via: 'test',
    });
    return source as DrizzleAgentStore & ActionProposalOutcomeStore;
  }
  it('pages exact UTF-16 identifiers after equal timestamps without losing proposals', async () => {
    const source = await setup();
    const original = required(await source.getActionProposal(scope, 'proposal'));
    for (const id of ['A', 'A\u0000', 'A ']) {
      await source.createActionProposal({
        ...scope,
        id,
        originRunId: 'run',
        originMessageId: 'message',
        originToolCallId: id,
        toolName: 'refund',
        input: {},
        confirmation: original.confirmation,
        approver: 'actor',
        expiresAt: null,
        idempotencyKey: id,
      });
    }
    const first = await source.listActionProposals(scope, { limit: 2, decision: 'pending' });
    expect(first.map((row) => row.id)).toEqual(['A', 'A\u0000']);
    const tail = required(first.at(-1));
    const second = await source.listActionProposals(scope, {
      limit: 2,
      decision: 'pending',
      after: { createdAt: tail.createdAt, id: tail.id },
    });
    expect(second.map((row) => row.id)).toEqual(['A ']);
  });
  it('admits one durable assistant fact with exact outcome metadata across replicas', async () => {
    const source = await setup();
    const claim = await source.claimNextActionProposalOutcome({ workerId: 'worker', leaseMs: 100 });
    expect(claim?.outcome.decision).toBe('rejected');
    const replica = store() as DrizzleAgentStore & ActionProposalOutcomeStore;
    const result = await replica.admitActionProposalOutcome(required(claim).lease);
    expect(result.status).toBe('applied');
    expect(await source.admitActionProposalOutcome(required(claim).lease)).toEqual({
      status: 'unchanged',
      messageId: result.messageId,
    });
    const thread = await source.getThread('thread');
    expect(thread?.messages).toHaveLength(1);
    expect(thread?.messages[0]).toMatchObject({
      role: 'assistant',
      actionProposalOutcome: { id: required(claim).outcome.id, decision: 'rejected' },
    });
    expect(thread?.messages[0]?.toolResults).toBeUndefined();
  });
  it('creates the latest replacement and closes the old card in one transaction', async () => {
    const source = await setup();
    const replacement = (id: string): CreateActionProposal => ({
      ...scope,
      id,
      originRunId: id,
      originMessageId: 'message',
      originToolCallId: id,
      toolName: 'edit',
      input: { id },
      confirmation: { title: 'Edit?', verb: 'Edit' },
      approver: 'actor',
      expiresAt: null,
      idempotencyKey: id,
      replacementKey: 'doc:123',
    });
    await source.createReplacingActionProposal(replacement('old'));
    await source.createReplacingActionProposal(replacement('new'));
    expect((await source.getActionProposal(scope, 'old'))?.decision).toBe('superseded');
    expect((await source.getActionProposal(scope, 'old'))?.supersededBy).toBe('new');
    expect((await source.getActionProposal(scope, 'new'))?.decision).toBe('pending');
    expect((await source.createReplacingActionProposal(replacement('old'))).status).toBe(
      'unchanged',
    );
    expect((await source.getActionProposal(scope, 'new'))?.decision).toBe('pending');
  });
  it('rolls back a replacement when closing the old card fails', async () => {
    const source = await setup();
    const replacement = (id: string): CreateActionProposal => ({
      ...scope,
      id,
      originRunId: id,
      originMessageId: 'message',
      originToolCallId: id,
      toolName: 'edit',
      input: null,
      confirmation: { title: 'Edit?', verb: 'Edit' },
      approver: 'actor',
      expiresAt: null,
      idempotencyKey: id,
      replacementKey: 'doc:123',
    });
    await source.createReplacingActionProposal(replacement('old'));
    intercept = (query) => {
      if (/^update ["`]?agent_action_proposal/u.test(query) && query.includes('delivery_status'))
        throw new Error('replacement-write-outage');
    };
    await expect(source.createReplacingActionProposal(replacement('new'))).rejects.toThrow();
    intercept = undefined;
    expect(await source.getActionProposal(scope, 'new')).toBeNull();
    expect((await source.getActionProposal(scope, 'old'))?.decision).toBe('pending');
  });
  it('persists exact JSON and late UI in canonical text on every dialect', async () => {
    const source = await setup();
    const original = required(await source.getActionProposal(scope, 'proposal'));
    await source.createActionProposal({
      ...scope,
      id: 'executed',
      originRunId: 'run',
      originMessageId: 'message',
      originToolCallId: 'late',
      toolName: 'tool\u0000\ud800',
      input: null,
      confirmation: { title: 'Execute?', verb: 'Execute' },
      approver: 'actor',
      expiresAt: null,
      idempotencyKey: 'late-key',
    });
    await source.decideActionProposal(scope, 'executed', {
      decision: 'approved',
      actorRef: 'actor',
      via: 'text',
    });
    const claimed = await source.claimActionProposal(scope, 'executed', {
      workerId: 'worker',
      leaseMs: 100,
    });
    const lease = required(required(required(claimed.proposal).execution).lease);
    const ui = [
      { id: 'ui', component: 'Table', props: { value: '\u0000\ud800', '\ud800': '\u0000' } },
    ];
    await source.settleActionProposal(scope, 'executed', {
      token: lease.token,
      generation: lease.generation,
      status: 'succeeded',
      result: { value: '\u0000\ud800' },
      ui,
    });
    // Admit the earlier rejection then the execution fact.
    for (let index = 0; index < 2; index++) {
      const outcome = await source.claimNextActionProposalOutcome({
        workerId: 'worker',
        leaseMs: 100,
      });
      expect(outcome).not.toBeNull();
      expect((await source.admitActionProposalOutcome(required(outcome).lease)).status).toBe(
        'applied',
      );
    }
    const messages = required(await source.getThread('thread')).messages;
    expect(messages).toHaveLength(2);
    const late = required(
      messages.find((message) => message.actionProposalOutcome?.proposalId === 'executed'),
    );
    expect(late.ui).toEqual(ui);
    expect(late.actionProposalOutcome?.result).toEqual({ value: '\u0000\ud800' });
    expect(late.content).toContain('\\u0000');
    expect(late.content).not.toContain('\u0000');
    expect(original.decision).toBe('rejected');
  });
  it('checks the delivery deadline again after acquiring the conversation lock', async () => {
    const source = await setup();
    const claim = await source.claimNextActionProposalOutcome({ workerId: 'worker', leaseMs: 100 });
    intercept = (query) => {
      if (/^select/u.test(query) && query.includes('agent_thread')) now = 1100;
    };
    expect(await source.admitActionProposalOutcome(required(claim).lease)).toEqual({
      status: 'conflict',
    });
    intercept = undefined;
    expect((await source.getThread('thread'))?.messages).toHaveLength(0);
  });
  it('rolls back the inserted fact when the proposal admission write fails', async () => {
    const source = await setup();
    const claim = await source.claimNextActionProposalOutcome({ workerId: 'worker', leaseMs: 100 });
    intercept = (query) => {
      if (/^update ["`]?agent_action_proposal/u.test(query) && query.includes('delivery_status'))
        throw new Error('admission-write-outage');
    };
    await expect(source.admitActionProposalOutcome(required(claim).lease)).rejects.toThrow();
    intercept = undefined;
    expect((await source.getThread('thread'))?.messages).toHaveLength(0);
    expect((await source.getActionProposal(scope, 'proposal'))?.outcomeDelivery?.status).toBe(
      'pending',
    );
    expect((await source.admitActionProposalOutcome(required(claim).lease)).status).toBe('applied');
  });
  it('serializes two worker claims and two admissions to one fact', async () => {
    const source = await setup();
    const peer = new DrizzleAgentStore(await handle.replica(), { clock: () => now });
    const claims = await Promise.all([
      source.claimNextActionProposalOutcome({ workerId: 'one', leaseMs: 100 }),
      peer.claimNextActionProposalOutcome({ workerId: 'two', leaseMs: 100 }),
    ]);
    expect(claims.filter(Boolean)).toHaveLength(1);
    const claim = required(claims.find(Boolean));
    const decisions = await Promise.all([
      source.admitActionProposalOutcome(claim.lease),
      peer.admitActionProposalOutcome(claim.lease),
    ]);
    expect(decisions.map(({ status }) => status).sort()).toEqual(['applied', 'unchanged']);
    expect((await source.getThread('thread'))?.messages).toHaveLength(1);
  });
  it('waits while a user turn owns the thread and recovers delivery after expiry', async () => {
    const source = await setup();
    const claim = await source.claimNextActionProposalOutcome({ workerId: 'worker', leaseMs: 100 });
    await source.claimActiveStream('thread', 'new-user-run');
    expect(await source.admitActionProposalOutcome(required(claim).lease)).toEqual({
      status: 'busy',
    });
    expect((await source.getThread('thread'))?.messages).toHaveLength(0);
    await source.releaseActiveStream('thread', 'new-user-run');
    now = 1100;
    expect((await source.admitActionProposalOutcome(required(claim).lease)).status).toBe(
      'conflict',
    );
    const recovery = await source.claimNextActionProposalOutcome({
      workerId: 'peer',
      leaseMs: 100,
    });
    expect(required(recovery).lease.generation).toBe(2);
    expect((await source.admitActionProposalOutcome(required(recovery).lease)).status).toBe(
      'applied',
    );
  });
  it('discards deleted conversations without resurrecting messages', async () => {
    const source = await setup();
    const claim = await source.claimNextActionProposalOutcome({ workerId: 'worker', leaseMs: 100 });
    await source.softDeleteThread('thread');
    expect(await source.admitActionProposalOutcome(required(claim).lease)).toEqual({
      status: 'discarded',
    });
    expect(
      await source.claimNextActionProposalOutcome({ workerId: 'peer', leaseMs: 100 }),
    ).toBeNull();
  });
  it('refuses a changed owner or tenant even for a valid delivery fence', async () => {
    const source = await setup();
    const claim = await source.claimNextActionProposalOutcome({ workerId: 'worker', leaseMs: 100 });
    await handle.run("update agent_thread set tenant_ref = 'other' where id = 'thread'");
    expect(await source.admitActionProposalOutcome(required(claim).lease)).toEqual({
      status: 'discarded',
    });
    expect((await source.getThread('thread'))?.messages).toHaveLength(0);
  });
  it('binds outcome delivery and replacement to the exact conversation identifier', async () => {
    const source = await setup();
    await source.claimNextActionProposalOutcome({ workerId: 'hold-original', leaseMs: 100 });
    const padded: CreateActionProposal = {
      ...scope,
      threadId: 'thread ',
      id: 'padded',
      originRunId: 'run',
      originMessageId: 'message',
      originToolCallId: 'call',
      toolName: 'refund',
      input: null,
      confirmation: { title: 'Refund?', verb: 'Refund' },
      approver: 'actor',
      expiresAt: null,
      idempotencyKey: 'padded',
    };
    await source.createActionProposal(padded);
    await source.decideActionProposal(padded, padded.id, {
      decision: 'rejected',
      actorRef: 'actor',
      via: 'test',
    });
    const claim = await source.claimNextActionProposalOutcome({ workerId: 'worker', leaseMs: 100 });
    expect(required(claim).outcome.proposalId).toBe('padded');
    expect(await source.admitActionProposalOutcome(required(claim).lease)).toEqual({
      status: 'discarded',
    });
    expect(await source.getThreadActionProposalScope('thread ')).toBeNull();
    expect(
      (
        await source.createReplacingActionProposal({
          ...padded,
          id: 'padded-replacement',
          replacementKey: 'same',
        })
      ).status,
    ).toBe('conflict');
    expect((await source.getThread('thread'))?.messages).toHaveLength(0);
  });
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected a persisted proposal, lease or message');
  return value;
}
