import { InMemoryAgentStore, ptBrActionProposalText } from '@dudousxd/nestjs-agent-core';
import { expect, it } from 'vitest';
import { ActionProposalService } from './action-proposal.service.js';
it('authorizes scoped requester decisions after origin completion and never treats approval as execution success', async () => {
  const store = new InMemoryAgentStore();
  await store.createThread({ id: 't', actor: { id: 'a', tenantRef: 'tenant' } });
  await store.createActionProposal({
    id: 'p',
    tenantRef: 'tenant',
    actorRef: 'a',
    threadId: 't',
    originRunId: 'ended',
    originMessageId: 'm',
    originToolCallId: 'c',
    toolName: 'send',
    input: null,
    confirmation: { title: 'Send', verb: 'Send' },
    approver: 'requester',
    expiresAt: null,
    idempotencyKey: 'key',
  });
  const service = new ActionProposalService(store, {});
  await expect(
    service.decide('t', 'p', { id: 'a', tenantRef: 'other' }, { decision: 'approved' }),
  ).rejects.toThrow();
  expect(
    await service.decide('t', 'p', { id: 'a', tenantRef: 'tenant' }, { decision: 'approved' }),
  ).toMatchObject({
    status: 'applied',
    proposal: { decision: 'approved', execution: { status: 'queued' } },
  });
});

it('requires current reviewer authorization and consumes explicit text only through the scoped decision path', async () => {
  const store = new InMemoryAgentStore();
  await store.createThread({ id: 't', actor: { id: 'a', tenantRef: 'tenant' } });
  for (const id of ['one', 'two'])
    await store.createActionProposal({
      id,
      tenantRef: 'tenant',
      actorRef: 'a',
      threadId: 't',
      originRunId: 'ended',
      originMessageId: 'm',
      originToolCallId: id,
      toolName: 'send',
      input: null,
      confirmation: { title: 'Send', verb: 'Send' },
      approver: 'admin',
      expiresAt: null,
      idempotencyKey: id,
    });
  const service = new ActionProposalService(store, {});
  const reviewer = { id: 'reviewer', roles: ['admin'], tenantRef: 'tenant' };
  await expect(
    service.decide('t', 'one', { id: 'reviewer', tenantRef: 'tenant' }, { decision: 'approved' }),
  ).rejects.toThrow();
  expect(await service.handleTextDecision('t', reviewer, 'yes')).toMatchObject({
    proposalDecision: { status: 'ambiguous', proposalIds: ['one', 'two'] },
    text: 'Which proposal? Reply confirm #ID or cancel #ID: one, two',
  });
  expect(await service.handleTextDecision('t', reviewer, 'yes #one')).toMatchObject({
    proposalDecision: {
      proposal: { decision: 'approved', decisionAudit: { actorRef: 'reviewer', via: 'text' } },
    },
  });
  expect(
    (await store.getActionProposal({ threadId: 't', actorRef: 'a', tenantRef: 'tenant' }, 'two'))
      ?.decision,
  ).toBe('pending');
});
it('lets the requester read a role-gated proposal without treating their text as authorized consent', async () => {
  const store = new InMemoryAgentStore();
  await store.createThread({ id: 't', actor: { id: 'a' } });
  await store.createActionProposal({
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
    approver: 'admin',
    expiresAt: null,
    idempotencyKey: 'key',
  });
  const service = new ActionProposalService(store, {});
  expect(await service.list('t', { id: 'a' })).toHaveLength(1);
  expect(await service.handleTextDecision('t', { id: 'a' }, 'yes')).toEqual({
    status: 'unmatched',
  });
});
it('never infers bare consent from a truncated pending candidate set', async () => {
  const store = new InMemoryAgentStore();
  await store.createThread({ id: 't', actor: { id: 'a' } });
  const template = {
    tenantRef: null,
    actorRef: 'a',
    threadId: 't',
    originRunId: 'r',
    originMessageId: 'm',
    originToolCallId: 'c',
    toolName: 'send',
    input: null,
    confirmation: { title: 'Send', verb: 'Send' },
    approver: 'admin',
    expiresAt: null,
    idempotencyKey: 'key',
  };
  for (let i = 0; i < 1000; i++)
    await store.createActionProposal({
      ...template,
      id: String(i),
      approver: i === 0 ? 'requester' : 'admin',
    });
  const service = new ActionProposalService(store, {});
  expect(await service.handleTextDecision('t', { id: 'a' }, 'yes')).toMatchObject({
    proposalDecision: { status: 'ambiguous' },
    text: 'There are several proposals. Confirm or reject one with an explicit #ID.',
  });
  expect((await store.getActionProposal(template, '0'))?.decision).toBe('pending');
});
it('keeps an authenticated explicit text target available beyond the candidate page', async () => {
  const store = new InMemoryAgentStore();
  await store.createThread({ id: 't', actor: { id: 'a' } });
  const template = {
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
  for (let i = 0; i < 1000; i++) await store.createActionProposal({ ...template, id: String(i) });
  await store.createActionProposal({ ...template, id: 'zz-hidden' });
  expect(
    (await store.listActionProposals(template, { limit: 1000 })).some(
      (proposal) => proposal.id === 'zz-hidden',
    ),
  ).toBe(false);
  const service = new ActionProposalService(store, {});
  expect(await service.handleTextDecision('t', { id: 'a' }, 'yes #zz-hidden')).toMatchObject({
    proposalDecision: { status: 'applied', proposal: { id: 'zz-hidden', decision: 'approved' } },
  });
});
it('advances a raw scoped cursor even when reviewer authorization hides an entire page', async () => {
  const store = new InMemoryAgentStore({ clock: () => 1000 });
  await store.createThread({ id: 't', actor: { id: 'owner' } });
  const template = {
    tenantRef: null,
    actorRef: 'owner',
    threadId: 't',
    originRunId: 'r',
    originMessageId: 'm',
    originToolCallId: 'c',
    toolName: 'send',
    input: null,
    confirmation: { title: 'Send', verb: 'Send' },
    approver: 'other',
    expiresAt: null,
    idempotencyKey: 'key',
  };
  for (let i = 0; i < 1000; i++) await store.createActionProposal({ ...template, id: String(i) });
  await store.createActionProposal({ ...template, id: 'zz-visible', approver: 'admin' });
  const service = new ActionProposalService(store, {});
  const reviewer = { id: 'reviewer', roles: ['admin'] };
  const first = await service.listPage('t', reviewer);
  expect(first.items).toEqual([]);
  expect(first.next).toBeDefined();
  if (!first.next) throw new Error('Missing raw-page cursor');
  const second = await service.listPage('t', reviewer, { after: first.next });
  expect(second.items.map((row) => row.id)).toEqual(['zz-visible']);
  expect(second.next).toBeUndefined();
});

async function oneProposal() {
  const store = new InMemoryAgentStore();
  await store.createThread({ id: 't', actor: { id: 'a' } });
  await store.createActionProposal({
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
  return store;
}
it('speaks English by default: English commands decide, Portuguese ones do not', async () => {
  const service = new ActionProposalService(await oneProposal(), {});
  expect(await service.handleTextDecision('t', { id: 'a' }, 'sim')).toEqual({
    status: 'unmatched',
  });
  expect(await service.handleTextDecision('t', { id: 'a' }, 'approve')).toMatchObject({
    proposalDecision: { status: 'applied' },
    text: 'Proposal approved and queued to run.',
  });
});
it('answers a rejection in English', async () => {
  const service = new ActionProposalService(await oneProposal(), {});
  expect(await service.handleTextDecision('t', { id: 'a' }, 'deny')).toMatchObject({
    text: 'Proposal rejected; nothing was run.',
  });
});
it('takes Portuguese commands and answers in Portuguese under the ptBr preset', async () => {
  const service = new ActionProposalService(await oneProposal(), {
    actionProposalText: ptBrActionProposalText,
  });
  expect(await service.handleTextDecision('t', { id: 'a' }, 'pode')).toMatchObject({
    proposalDecision: { status: 'applied' },
    text: 'Confirmado! Já estou cuidando disso.',
  });
});
it('keeps English working under the ptBr preset', async () => {
  const service = new ActionProposalService(await oneProposal(), {
    actionProposalText: ptBrActionProposalText,
  });
  expect(await service.handleTextDecision('t', { id: 'a' }, 'cancel')).toMatchObject({
    text: 'Tudo bem, cancelado. Nada foi feito.',
  });
});
