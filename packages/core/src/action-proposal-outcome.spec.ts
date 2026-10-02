import { describe, expect, it } from 'vitest';
import { InMemoryActionProposalStore } from './in-memory-action-proposal-store.js';

const creation = {
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
  expiresAt: 2000,
  idempotencyKey: 'key',
};

describe('atomic action proposal outcomes', () => {
  it('writes one rejection outcome in the decision row and preserves it on replay', async () => {
    const store = new InMemoryActionProposalStore({ clock: () => 1000 });
    await store.createActionProposal(creation);
    const first = await store.decideActionProposal(creation, 'p', {
      decision: 'rejected',
      actorRef: 'a',
      via: 'button',
      reason: 'No',
    });
    expect(first.proposal).toMatchObject({
      outcome: { proposalId: 'p', decision: 'rejected', error: 'No', ui: [] },
      outcomeDelivery: { status: 'pending', generation: 0, lease: null },
    });
    const replay = await store.decideActionProposal(creation, 'p', {
      decision: 'rejected',
      actorRef: 'other',
      via: 'other',
    });
    expect(replay.proposal).toEqual(first.proposal);
  });
  it('writes terminal result and UI only with a winning execution fence', async () => {
    const store = new InMemoryActionProposalStore({ clock: () => 1000 });
    await store.createActionProposal(creation);
    await store.decideActionProposal(creation, 'p', {
      decision: 'approved',
      actorRef: 'a',
      via: 'button',
    });
    const claim = await store.claimActionProposal(creation, 'p', { workerId: 'w', leaseMs: 100 });
    const lease = required(claim.proposal?.execution?.lease);
    const result = await store.settleActionProposal(creation, 'p', {
      ...lease,
      status: 'succeeded',
      result: null,
    });
    expect(result.proposal).toMatchObject({
      outcome: { decision: 'approved', executionStatus: 'succeeded', result: null, ui: [] },
      outcomeDelivery: { status: 'pending' },
    });
    const stale = await store.settleActionProposal(creation, 'p', {
      ...lease,
      status: 'failed',
      error: 'stale',
    });
    expect(stale.status).toBe('conflict');
    expect(stale.proposal).toEqual(result.proposal);
  });
  it('captures implicit expiry and validates strict JSON UI before settlement', async () => {
    let now = 1000;
    const store = new InMemoryActionProposalStore({ clock: () => now });
    await store.createActionProposal(creation);
    now = 2000;
    const result = await store.decideActionProposal(creation, 'p', {
      decision: 'approved',
      actorRef: 'a',
      via: 'button',
    });
    expect(result.status).toBe('expired');
    expect(result.proposal).toMatchObject({
      outcome: { decision: 'expired' },
      outcomeDelivery: { status: 'pending' },
    });
  });
});

it('admits one assistant fact with scope checks only while the conversation is idle', async () => {
  const { InMemoryAgentStore } = await import('./in-memory-store.js');
  const store = new InMemoryAgentStore({ clock: () => 1000 });
  const thread = await store.createThread({ id: 't', actor: { id: 'a', tenantRef: 'tenant' } });
  const input = { ...creation, tenantRef: 'tenant', threadId: thread.id };
  await store.createActionProposal(input);
  await store.decideActionProposal(input, 'p', {
    decision: 'rejected',
    actorRef: 'a',
    via: 'button',
  });
  const work = await store.claimNextActionProposalOutcome({ workerId: 'w', leaseMs: 100 });
  expect(work).not.toBeNull();
  await store.claimActiveStream('t', 'run');
  expect(await store.admitActionProposalOutcome(required(work?.lease))).toEqual({ status: 'busy' });
  await store.releaseActiveStream('t', 'run');
  const admitted = await store.admitActionProposalOutcome(required(work?.lease));
  expect(admitted.status).toBe('applied');
  expect(await store.admitActionProposalOutcome(required(work?.lease))).toEqual({
    status: 'unchanged',
    messageId: admitted.messageId,
  });
  expect((await store.getThread('t'))?.messages).toEqual([
    expect.objectContaining({ role: 'assistant', actionProposalOutcome: work?.outcome }),
  ]);
  expect(await store.getThreadActionProposalScope('t')).toEqual({
    threadId: 't',
    actorRef: 'a',
    tenantRef: 'tenant',
  });
});
it('supersedes only matching pending proposals atomically when creating an explicit replacement', async () => {
  const store = new InMemoryActionProposalStore({ clock: () => 1000 });
  await store.createReplacingActionProposal({ ...creation, replacementKey: 'recipient' });
  const next = await store.createReplacingActionProposal({
    ...creation,
    id: 'next',
    input: { changed: true },
    replacementKey: 'recipient',
  });
  expect(next.status).toBe('created');
  expect((await store.getActionProposal(creation, 'p'))?.decision).toBe('superseded');
  expect((await store.getActionProposal(creation, 'p'))?.outcome?.decision).toBe('superseded');
  expect(
    (await store.createReplacingActionProposal({ ...creation, replacementKey: 'recipient' }))
      .status,
  ).toBe('unchanged');
  expect((await store.getActionProposal(creation, 'next'))?.decision).toBe('pending');
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected fixture value');
  return value;
}
