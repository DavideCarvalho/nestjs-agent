import { describe, expect, it } from 'vitest';
import {
  initialActionProposal,
  transitionActionProposalDecision,
} from './action-proposal-transitions.js';
import { transitionActionProposalSupersession } from './action-proposal-transitions.js';
import type { CreateActionProposal } from './spi/action-proposal-store.js';
const input: CreateActionProposal = {
  id: 'old',
  tenantRef: null,
  actorRef: 'actor',
  threadId: 'thread',
  originRunId: 'run',
  originMessageId: 'message',
  originToolCallId: 'call',
  toolName: 'update',
  input: null,
  confirmation: { title: 'Update?', verb: 'Update' },
  approver: 'actor',
  expiresAt: 2000,
  idempotencyKey: 'stable',
  replacementKey: 'document:123',
};
const command = { replacementProposalId: 'new', actorRef: 'actor', via: 'replacement' };
describe('explicit action supersession', () => {
  it('closes only the matching pending action and atomically creates its terminal outcome', () => {
    const old = initialActionProposal(input, 1000);
    const replacement = initialActionProposal(
      { ...input, id: 'new', originRunId: 'next-run' },
      1100,
    );
    const result = transitionActionProposalSupersession(old, replacement, command, 1100);
    expect(result.status).toBe('applied');
    expect(result.proposal).toMatchObject({
      decision: 'superseded',
      supersededBy: 'new',
      execution: null,
      decisionAudit: { replacementProposalId: 'new', actorRef: 'actor', via: 'replacement' },
      outcome: { decision: 'superseded' },
      outcomeDelivery: { status: 'pending' },
    });
    expect(
      transitionActionProposalSupersession(required(result.proposal), replacement, command, 1200),
    ).toEqual({ status: 'unchanged', proposal: result.proposal });
    expect(old.decision).toBe('pending');
  });
  it.each([
    { tenantRef: 'other' },
    { actorRef: 'other' },
    { threadId: 'other' },
    { toolName: 'other' },
    { replacementKey: 'other' },
    { id: 'old' },
  ])('never replaces a differently addressed action: %j', (patch) => {
    const old = initialActionProposal(input, 1000);
    const replacement = initialActionProposal({ ...input, id: 'new', ...patch }, 1100);
    expect(transitionActionProposalSupersession(old, replacement, command, 1100).status).toBe(
      'conflict',
    );
  });
  it('preserves approval that won before replacement', () => {
    const approved = transitionActionProposalDecision(
      initialActionProposal(input, 1000),
      { decision: 'approved', actorRef: 'actor', via: 'button' },
      1000,
    ).proposal;
    if (!approved) throw new Error('Expected an approved proposal');
    const replacement = initialActionProposal({ ...input, id: 'new' }, 1100);
    const result = transitionActionProposalSupersession(approved, replacement, command, 1100);
    expect(result).toEqual({ status: 'conflict', proposal: approved });
  });
  it('expires the old card at its deadline instead of rewriting the decision as superseded', () => {
    const old = initialActionProposal(input, 1000);
    const replacement = initialActionProposal({ ...input, id: 'new' }, 2000);
    const result = transitionActionProposalSupersession(old, replacement, command, 2000);
    expect(result.status).toBe('expired');
    expect(result.proposal?.decision).toBe('expired');
  });
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected a persisted proposal, lease or message');
  return value;
}
