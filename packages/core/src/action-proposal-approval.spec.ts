import { expect, it } from 'vitest';
import { resolveActionProposalApproval } from './action-proposal-approval.js';
const actor = { id: 'actor', roles: [] };
const thread = { threadId: 'thread', runId: 'run' };
const tool = { name: 'send', kind: 'action' as const };
it('resolves policy once and skips remembered reads for automatic tools', async () => {
  let reads = 0;
  let policies = 0;
  expect(
    await resolveActionProposalApproval({
      actor,
      thread,
      tool,
      store: {
        rememberedApprovals: async () => {
          reads++;
          return ['send'];
        },
      },
      policy: {
        requirementFor: () => {
          policies++;
          return { required: false, approver: 'requester' };
        },
      },
    }),
  ).toEqual({ mode: 'auto' });
  expect({ reads, policies }).toEqual({ reads: 0, policies: 1 });
});
it('remembers only the named tool and journals the recorded approver', async () => {
  expect(
    await resolveActionProposalApproval({
      actor,
      thread,
      tool,
      store: { rememberedApprovals: async () => ['send'] },
    }),
  ).toEqual({ mode: 'remembered', approver: 'requester' });
});
it('computes an approval deadline from a trusted clock once', async () => {
  expect(
    await resolveActionProposalApproval({
      actor,
      thread,
      tool,
      store: {},
      clock: () => 1000,
      policy: { requirementFor: () => ({ required: true, approver: 'reviewer', ttlMs: 500 }) },
    }),
  ).toEqual({
    mode: 'ask',
    approver: 'reviewer',
    ttlMs: 500,
    expiresAt: new Date(1500).toISOString(),
  });
});
