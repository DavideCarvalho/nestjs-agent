import {
  type ActionProposal,
  InMemoryAgentStore,
  ptBrActionProposalText,
} from '@dudousxd/nestjs-agent-core';
import { InMemoryAttachmentStagingStore } from '@dudousxd/nestjs-agent-testing';
import {
  NotFoundException,
  NotImplementedException,
  PayloadTooLargeException,
  UnsupportedMediaTypeException,
} from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { AgentDepsFactory } from './agent-deps.factory.js';
import type { AgentModuleOptions } from './agent.options.js';
import { AgentService } from './agent.service.js';
import { ActionProposalWorkerService } from './proposals/action-proposal-worker.service.js';
import { ActionProposalService } from './proposals/action-proposal.service.js';

/** The seams a surface outside the HTTP routes (a text channel) builds on. */

const runner = {
  start: async () => ({ runId: 'run-1' }),
  signal: async () => undefined,
  cancel: async () => undefined,
};
const deps = { defaultAgentName: () => 'default' } as unknown as AgentDepsFactory;
const actor = { id: 'u1' };

function service(
  options: Partial<AgentModuleOptions> = {},
  extra: { staging?: InMemoryAttachmentStagingStore; store?: InMemoryAgentStore } = {},
) {
  const store = extra.store ?? new InMemoryAgentStore();
  const proposals = new ActionProposalService(store, options);
  return new AgentService(
    runner,
    store,
    deps,
    extra.staging,
    undefined,
    undefined,
    options,
    undefined,
    proposals,
  );
}

describe('AgentService — approvals, for surfaces without a web UI', () => {
  it('says which approval mode is on', () => {
    expect(service().actionApprovalMode()).toBe('blocking');
    expect(service({ actionApprovalMode: 'independent' }).actionApprovalMode()).toBe('independent');
  });

  it('hands out the configured text vocabulary and replies', () => {
    const english = service();
    expect(english.actionProposalVocabulary().approve[0]).toBe('yes');
    expect(english.actionProposalReply({ status: 'not_found' }, 'approved')).toBe(
      'This proposal could not be changed; refresh the list to see where it stands.',
    );
    const portuguese = service({ actionProposalText: ptBrActionProposalText });
    expect(portuguese.actionProposalVocabulary().approve[0]).toBe('sim');
    expect(portuguese.actionProposalReply({ status: 'applied' }, 'rejected')).toBe(
      'Proposta rejeitada; nenhuma ação foi executada.',
    );
  });

  it('lists a thread’s proposals only under independent approvals', async () => {
    const store = new InMemoryAgentStore();
    const thread = await store.createThread({ actor });
    await expect(service({}, { store }).listActionProposals(actor, thread.id)).rejects.toThrow(
      NotFoundException,
    );
    await store.createActionProposal({
      id: 'p1',
      tenantRef: null,
      actorRef: actor.id,
      threadId: thread.id,
      originRunId: 'r',
      originMessageId: 'm',
      originToolCallId: 'c',
      toolName: 'refund',
      input: null,
      confirmation: { title: 'Refund', verb: 'Refund' },
      approver: 'requester',
      expiresAt: null,
      idempotencyKey: 'k',
    });
    const listed = await service(
      { actionApprovalMode: 'independent' },
      { store },
    ).listActionProposals(actor, thread.id);
    expect(listed.map((proposal) => proposal.id)).toEqual(['p1']);
    // the public view: no idempotency key, no execution address
    expect(listed[0]).not.toHaveProperty('idempotencyKey');
  });
});

describe('AgentService — staging a file a surface received itself', () => {
  const file = (contentType: string, size = 4) => ({
    data: Buffer.alloc(size),
    contentType,
    filename: 'photo.jpg',
  });

  it('refuses when attachments are off, and says so in its limits', async () => {
    const agent = service();
    expect(agent.attachmentLimits().enabled).toBe(false);
    await expect(agent.stageAttachment(actor, file('image/jpeg'))).rejects.toThrow(
      NotImplementedException,
    );
  });

  it('holds a file to the configured type allowlist and size cap', async () => {
    const staging = new InMemoryAttachmentStagingStore();
    const agent = service({ attachments: { maxBytes: 10 } }, { staging });
    expect(agent.attachmentLimits()).toMatchObject({ enabled: true, maxBytes: 10 });
    await expect(agent.stageAttachment(actor, file('audio/ogg'))).rejects.toThrow(
      UnsupportedMediaTypeException,
    );
    await expect(agent.stageAttachment(actor, file('image/jpeg', 11))).rejects.toThrow(
      PayloadTooLargeException,
    );
    const staged = await agent.stageAttachment(actor, file('IMAGE/JPEG; charset=binary'));
    expect(staged).toMatchObject({ contentType: 'image/jpeg', name: 'photo.jpg' });
    expect(await staging.resolve({ mediaId: staged.mediaId, actor })).not.toBeNull();
  });
});

describe('ActionProposalWorkerService.onSettled', () => {
  it('runs the configured hook and every subscribed listener, each isolated from the others', async () => {
    const seen: string[] = [];
    const worker = new ActionProposalWorkerService(
      new InMemoryAgentStore(),
      {
        actionProposalWorker: {
          onSettled: (proposal) => {
            seen.push(`config:${proposal.id}`);
          },
        },
      } as AgentModuleOptions,
      deps,
    );
    worker.onSettled(() => {
      throw new Error('a broken listener');
    });
    const unsubscribe = worker.onSettled((proposal) => {
      seen.push(`listener:${proposal.id}`);
    });
    const settle = (
      worker as unknown as { settled(p: ActionProposal): Promise<void> }
    ).settled.bind(worker);
    (worker as unknown as { logger: { error(): void } }).logger = { error: () => {} };
    await settle({ id: 'p1' } as ActionProposal);
    unsubscribe();
    await settle({ id: 'p2' } as ActionProposal);
    expect(seen).toEqual(['config:p1', 'listener:p1', 'config:p2']);
  });
});
