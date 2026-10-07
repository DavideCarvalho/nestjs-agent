import type { ActionProposal, StoredMessage } from '@dudousxd/nestjs-agent-core';
import type { UIMessage } from 'ai';
import { expect, it } from 'vitest';
import { storedThreadToUiMessages } from '../stored-thread-to-ui-messages.js';
import { buildTranscriptBlocks } from '../transcript/model.js';
import { proposalNeedsPolling, reconcileProposalMessages } from './proposals.js';

const proposal = {
  id: 'proposal',
  threadId: 'thread',
  originToolCallId: 'call',
  decision: 'pending',
  approver: 'reviewer',
  expiresAt: null,
  confirmation: { title: 'Approve?', verb: 'Approve' },
  execution: null,
  decisionAudit: null,
} as ActionProposal;
it('keeps pending receipts truthful and applies independent state by proposal id', () => {
  const message: UIMessage = {
    id: 'origin',
    role: 'assistant',
    parts: [
      {
        type: 'tool-refund',
        toolCallId: 'call',
        state: 'output-available',
        input: {},
        output: { proposalId: 'proposal', status: 'pending', executed: false },
      },
    ],
  };
  const result = reconcileProposalMessages([message], [proposal], []);
  expect(result[0]?.parts[0]).toEqual(message.parts[0]);
  expect(result[0]?.parts.find((part) => part.type === 'data-action-proposal')).toMatchObject({
    data: {
      id: 'call',
      target: { kind: 'proposal', proposalId: 'proposal', threadId: 'thread' },
      status: 'pending',
    },
  });
  expect(proposalNeedsPolling(proposal)).toBe(true);
});
it('adds one persisted outcome with late UI while preserving newer active messages', () => {
  const active: UIMessage = {
    id: 'live',
    role: 'assistant',
    parts: [{ type: 'text', text: 'unpersisted live text' }],
  };
  const fact = {
    id: 'fact',
    role: 'assistant',
    content: 'Refund succeeded',
    actionProposalOutcome: { id: 'outcome' },
    ui: [{ id: 'card', component: 'Text', props: { text: 'Refund succeeded' } }],
  } as unknown as StoredMessage;
  const merged = reconcileProposalMessages([active], [], [fact]);
  expect(merged[0]).toBe(active);
  expect(merged[1]?.parts.some((part) => part.type === 'data-ui')).toBe(true);
  expect(reconcileProposalMessages(merged, [], [fact])).toEqual(merged);
  expect(
    proposalNeedsPolling({
      ...proposal,
      decision: 'approved',
      execution: { status: 'executing', generation: 1 },
    }),
  ).toBe(true);
});

it('routes a pending receipt through an explicit proposal target and shows queued state without success', () => {
  const origin: UIMessage = {
    id: 'origin',
    role: 'assistant',
    parts: [
      {
        type: 'tool-refund',
        toolCallId: 'call',
        state: 'output-available',
        input: {},
        output: { proposalId: 'proposal', executed: false, status: 'pending' },
      },
    ],
  };
  const approve = (_id: string, _options?: unknown, target?: unknown) => {
    expect(target).toEqual({ kind: 'proposal', proposalId: 'proposal', threadId: 'thread' });
  };
  const options = {
    isReasoningOpen: () => false,
    toggleReasoning: () => {},
    approval: {
      canApprove: true,
      canReject: true,
      approve,
      reject: () => {},
      submitting: () => null,
      errorOf: () => null,
    },
  };
  const message = reconcileProposalMessages([origin], [proposal], [])[0];
  if (!message) throw new Error('Missing origin');
  const block = buildTranscriptBlocks(message, options).find((block) => block.kind === 'tools');
  if (block?.kind !== 'tools') throw new Error('Missing tools');
  expect(block.calls[0]?.isAwaitingApproval).toBe(true);
  expect(block.calls[0]?.description.phrase).toBe('Awaiting approval');
  block.calls[0]?.approve.run();
  const queued = reconcileProposalMessages(
    [origin],
    [
      {
        ...proposal,
        decision: 'approved',
        execution: { status: 'queued', generation: 0 },
      },
    ],
    [],
  )[0];
  if (!queued) throw new Error('Missing queued');
  const queuedBlock = buildTranscriptBlocks(queued, options).find(
    (block) => block.kind === 'tools',
  );
  if (queuedBlock?.kind !== 'tools') throw new Error('Missing tools');
  expect(queuedBlock.calls[0]?.description.phrase).toBe('Queued');
  expect(queuedBlock.calls[0]?.approve.available).toBe(false);
});
it('keeps standalone persisted outcome facts distinct from the origin turn on reload', () => {
  const origin = { id: 'origin', role: 'assistant', content: 'Pending' } as StoredMessage;
  const fact = {
    id: 'fact',
    role: 'assistant',
    content: 'Done',
    actionProposalOutcome: { id: 'outcome' },
  } as unknown as StoredMessage;
  expect(storedThreadToUiMessages([origin, fact]).map((message) => message.id)).toEqual([
    'origin',
    'fact',
  ]);
});

it('retains a persisted proposal pointer before polling rather than using legacy signaling', () => {
  const stored = {
    id: 'origin',
    role: 'assistant',
    content: '',
    toolCalls: [{ id: 'call', name: 'refund', input: {}, kind: 'action' }],
    toolResults: [
      {
        id: 'call',
        name: 'refund',
        output: { proposalId: 'proposal', status: 'pending', executed: false },
      },
    ],
    approvals: [
      { toolCallId: 'call', proposalId: 'proposal', status: 'pending', approver: 'reviewer' },
    ],
  } as StoredMessage;
  const mapped = storedThreadToUiMessages([stored])[0];
  if (!mapped) throw new Error('Missing origin');
  const block = buildTranscriptBlocks(mapped, {
    isReasoningOpen: () => false,
    toggleReasoning: () => {},
  }).find((block) => block.kind === 'tools');
  if (block?.kind !== 'tools') throw new Error('Missing tools');
  expect(block.calls[0]?.approval?.target).toEqual({ kind: 'proposal', proposalId: 'proposal' });
  expect(block.calls[0]?.approval?.status).toBe('pending');
  expect(block.calls[0]?.description.phrase).toBe('Awaiting approval');
});

it('never attaches proposals to colliding calls from other runs and tolerates extreme expiry', () => {
  const message = (id: string, proposalId: string): UIMessage => ({
    id,
    role: 'assistant',
    parts: [
      {
        type: 'tool-refund',
        toolCallId: 'call',
        state: 'output-available',
        input: {},
        output: { proposalId, executed: false },
      },
    ],
  });
  const result = reconcileProposalMessages(
    [message('old', 'old-proposal'), message('new', 'proposal')],
    [{ ...proposal, expiresAt: Number.MAX_SAFE_INTEGER }],
    [],
  );
  expect(result[0]?.parts).toHaveLength(1);
  expect(result[1]?.parts).toHaveLength(2);
});
