import { InMemoryAgentStore, InMemoryGovernanceQueries } from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import { approvalPosterior, buildApprovalPrior, loadApprovalPrior } from './approval-prior.js';

describe('buildApprovalPrior', () => {
  it('counts an approved-then-crashed action as approved, and ignores undecided ones', () => {
    const prior = buildApprovalPrior([
      { toolName: 'restartPod', status: 'executed' },
      { toolName: 'restartPod', status: 'failed' },
      { toolName: 'restartPod', status: 'rejected' },
      { toolName: 'restartPod', status: 'pending_approval' },
    ]);

    expect(prior.get('restartPod')).toEqual({ approved: 2, rejected: 1 });
  });

  it('leaves a tool nobody decided on out of the corpus entirely', () => {
    const prior = buildApprovalPrior([{ toolName: 'purgeCache', status: 'pending_approval' }]);

    expect(prior.has('purgeCache')).toBe(false);
  });
});

describe('approvalPosterior', () => {
  it('reads a tool with no history as exactly 0.5', () => {
    expect(approvalPosterior(undefined)).toBe(0.5);
  });

  it('keeps a single rejection short of certainty, and lets evidence move it', () => {
    expect(approvalPosterior({ approved: 0, rejected: 1 })).toBeCloseTo(1 / 3, 10);
    expect(approvalPosterior({ approved: 1, rejected: 5 })).toBeCloseTo(0.25, 10);
    expect(approvalPosterior({ approved: 0, rejected: 50 })).toBeLessThan(0.02);
  });
});

describe('loadApprovalPrior', () => {
  it('mines the store’s own HITL history, ignoring read tools', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: { id: 'alice' }, title: 'ops' });
    const message = await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: 'proposing',
    });
    await store.recordToolCall({
      toolCallId: 'tc-1',
      messageId: message.id,
      toolName: 'purgeCache',
      toolType: 'action',
      input: {},
      status: 'pending_approval',
    });
    await store.updateToolCall({ toolCallId: 'tc-1', status: 'rejected' });
    await store.recordToolCall({
      toolCallId: 'tc-2',
      messageId: message.id,
      toolName: 'restartPod',
      toolType: 'action',
      input: {},
      status: 'pending_approval',
    });
    await store.updateToolCall({ toolCallId: 'tc-2', status: 'executed' });
    await store.recordToolCall({
      toolCallId: 'tc-3',
      messageId: message.id,
      toolName: 'listPods',
      toolType: 'read',
      input: {},
      status: 'auto_executed',
    });
    await store.updateToolCall({ toolCallId: 'tc-3', status: 'executed' });

    const prior = await loadApprovalPrior(new InMemoryGovernanceQueries(store));

    expect(prior.get('purgeCache')).toEqual({ approved: 0, rejected: 1 });
    expect(prior.get('restartPod')).toEqual({ approved: 1, rejected: 0 });
    expect(prior.has('listPods')).toBe(false);
  });

  it('walks past the first page instead of stopping at it', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: { id: 'alice' }, title: 'ops' });
    const message = await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: 'proposing',
    });
    for (let index = 0; index < 5; index += 1) {
      const toolCallId = `tc-${index}`;
      await store.recordToolCall({
        toolCallId,
        messageId: message.id,
        toolName: 'purgeCache',
        toolType: 'action',
        input: {},
        status: 'pending_approval',
      });
      await store.updateToolCall({ toolCallId, status: 'rejected' });
    }

    const prior = await loadApprovalPrior(new InMemoryGovernanceQueries(store), { pageSize: 2 });

    expect(prior.get('purgeCache')).toEqual({ approved: 0, rejected: 5 });
  });

  it('stops at maxRows so a prior can never become an unbounded scan', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor: { id: 'alice' }, title: 'ops' });
    const message = await store.appendMessage({
      threadId: thread.id,
      role: 'assistant',
      content: 'proposing',
    });
    for (let index = 0; index < 6; index += 1) {
      const toolCallId = `tc-${index}`;
      await store.recordToolCall({
        toolCallId,
        messageId: message.id,
        toolName: 'purgeCache',
        toolType: 'action',
        input: {},
        status: 'pending_approval',
      });
      await store.updateToolCall({ toolCallId, status: 'rejected' });
    }

    const prior = await loadApprovalPrior(new InMemoryGovernanceQueries(store), {
      pageSize: 2,
      maxRows: 4,
    });

    expect(prior.get('purgeCache')).toEqual({ approved: 0, rejected: 4 });
  });
});
