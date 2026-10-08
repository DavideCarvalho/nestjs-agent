import { InMemoryAgentStore, type ToolPreflightResult } from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider } from '@dudousxd/nestjs-agent-testing';
import { Injectable } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { expect, it } from 'vitest';
import { z } from 'zod';
import { AgentModule } from '../agent.module.js';
import { AiTool } from '../decorator/ai-tool.decorator.js';
import { ActionProposalWorkerService } from './action-proposal-worker.service.js';
let effects = 0;
@AiTool({
  name: 'send',
  kind: 'action',
  description: 'Send',
  input: z.object({ amount: z.number().default(5) }),
})
@Injectable()
class SendTool {
  preflight(input: { amount: number }): ToolPreflightResult {
    return { status: 'ready', confirmation: { title: `Send ${input.amount}`, verb: 'Send' } };
  }
  async execute(input: { amount: number }) {
    effects++;
    return input;
  }
}
it('ends the origin SSE, accepts another turn, approves independently and persists one late assistant fact', async () => {
  effects = 0;
  const actor = { id: 'a' };
  const store = new InMemoryAgentStore();
  const thread = await store.createThread({ actor });
  const module = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        store,
        actionApprovalMode: 'independent',
        actorResolver: { resolve: () => actor },
        backgroundActorResolver: { resolve: async () => actor },
        model: new FakeModelProvider((args) =>
          args.messages.at(-1)?.content === 'send'
            ? { text: 'Prepared', toolCall: { name: 'send', input: {} } }
            : { text: 'Hello' },
        ),
      }),
    ],
    providers: [SendTool],
  }).compile();
  const app = module.createNestApplication<NestExpressApplication>();
  await app.init();
  try {
    const server = app.getHttpServer();
    await request(server)
      .post('/agent/chat')
      .send({
        threadId: thread.id,
        message: 'send',
        uiCapabilities: { components: [{ name: 'Note', version: -1 }] },
      })
      .expect(400);
    const origin = await request(server)
      .post('/agent/chat')
      .send({ threadId: thread.id, message: 'send' })
      .expect(201);
    expect(origin.text).toContain('pending');
    expect(effects).toBe(0);
    const scope = { threadId: thread.id, actorRef: 'a', tenantRef: null };
    const proposals = await store.listActionProposals(scope);
    expect(proposals).toHaveLength(1);
    await request(server)
      .post('/agent/chat')
      .send({ threadId: thread.id, message: 'hello' })
      .expect(201);
    await request(server)
      .post(`/agent/threads/${thread.id}/action-proposals/${required(proposals[0]).id}/approve`)
      .send({ tenantRef: 'forged' })
      .expect(400);
    const decision = await request(server)
      .post(`/agent/threads/${thread.id}/action-proposals/${required(proposals[0]).id}/approve`)
      .send({})
      .expect(201);
    expect(decision.body.proposal.execution.status).toBe('queued');
    const worker = module.get(ActionProposalWorkerService);
    await worker.onModuleDestroy();
    // A fresh process worker discovers durable queued work; starting it does not create a model run.
    worker.onModuleInit();
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 3000;
      const timer = setInterval(async () => {
        const current = await store.getActionProposal(scope, required(proposals[0]).id);
        if (current?.outcomeDelivery?.status === 'admitted') {
          clearInterval(timer);
          resolve();
        } else if (Date.now() > deadline) {
          clearInterval(timer);
          reject(new Error('Outcome not admitted'));
        }
      }, 20);
    });
    expect(effects).toBe(1);
    const messages = required((await store.getThread(thread.id))?.messages);
    expect(messages.filter((message) => message.actionProposalOutcome)).toHaveLength(1);
    expect(messages.find((message) => message.toolResults)?.toolResults?.[0]?.output).toEqual({
      proposalId: required(proposals[0]).id,
      status: 'pending',
      executed: false,
    });
    const template = required(proposals[0]);
    for (let index = 0; index < 1001; index++)
      await store.createActionProposal({
        id: `page-${index}`,
        ...scope,
        originRunId: template.originRunId,
        originMessageId: template.originMessageId,
        originToolCallId: `page-call-${index}`,
        toolName: template.toolName,
        input: null,
        confirmation: template.confirmation,
        approver: 'requester',
        expiresAt: null,
        idempotencyKey: `page-${index}`,
      });
    const firstPage = await request(server)
      .get(`/agent/threads/${thread.id}/action-proposals`)
      .expect(200);
    expect(firstPage.body).toHaveLength(1000);
    const next = firstPage.headers['x-action-proposals-next'];
    expect(typeof next).toBe('string');
    if (typeof next !== 'string') throw new Error('Missing next-page header');
    const after = decodeURIComponent(next);
    const secondPage = await request(server)
      .get(`/agent/threads/${thread.id}/action-proposals`)
      .query({ after })
      .expect(200);
    expect(secondPage.body).toHaveLength(2);
    expect(secondPage.headers['x-action-proposals-next']).toBeUndefined();
    await request(server)
      .get(`/agent/threads/${thread.id}/action-proposals`)
      .query({ after: '{"createdAt":0,"id":"","forged":true}' })
      .expect(400);
  } finally {
    await app.close();
  }
});

function required<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('Expected fixture value');
  return value;
}

it('never lets a lease token, idempotency key or execution address leave over HTTP', async () => {
  const actor = { id: 'a' };
  const store = new InMemoryAgentStore();
  const thread = await store.createThread({ actor });
  const scope = { threadId: thread.id, actorRef: 'a', tenantRef: null };
  const base = {
    ...scope,
    originRunId: 'r',
    originMessageId: 'm',
    toolName: 'send',
    input: { amount: 5 },
    preparationInput: { amount: 5 },
    executionContext: { requestId: 'secret-request' },
    confirmation: { title: 'Send 5', verb: 'Send' },
    approver: 'requester',
    expiresAt: null,
  };
  await store.createActionProposal({
    ...base,
    id: 'leased',
    originToolCallId: 'c1',
    idempotencyKey: 'secret-key-1',
  });
  await store.createActionProposal({
    ...base,
    id: 'pending',
    originToolCallId: 'c2',
    idempotencyKey: 'secret-key-2',
  });
  await store.decideActionProposal(scope, 'leased', {
    decision: 'approved',
    actorRef: 'a',
    via: 'web',
  });
  const claimed = await store.claimActionProposal(scope, 'leased', {
    workerId: 'worker-secret',
    leaseMs: 60_000,
  });
  const token = required(claimed.proposal?.execution?.lease).token;
  const module = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        store,
        actionApprovalMode: 'independent',
        actorResolver: { resolve: () => actor },
        backgroundActorResolver: { resolve: async () => actor },
        actionProposalWorker: { pollIntervalMs: 60_000, leaseMs: 600_000 },
        model: new FakeModelProvider(() => ({ text: 'Hello' })),
      }),
    ],
  }).compile();
  const app = module.createNestApplication<NestExpressApplication>();
  await app.init();
  try {
    const server = app.getHttpServer();
    const leaks = ['secret-key', 'secret-request', 'worker-secret', token, 'preparationInput'];
    const list = await request(server)
      .get(`/agent/threads/${thread.id}/action-proposals`)
      .expect(200);
    expect(list.body.map((row: { id: string }) => row.id).sort()).toEqual(['leased', 'pending']);
    expect(list.body.find((row: { id: string }) => row.id === 'leased').execution).toMatchObject({
      status: 'executing',
    });
    const decided = await request(server)
      .post(`/agent/threads/${thread.id}/action-proposals/pending/approve`)
      .send({})
      .expect(201);
    const texted = await request(server)
      .post('/agent/chat')
      .send({ threadId: thread.id, message: 'approve #leased' });
    for (const body of [list.text, decided.text, texted.text]) {
      for (const secret of leaks) expect(body).not.toContain(secret);
    }
  } finally {
    await app.close();
  }
});

it('lists no proposals (200, []) in blocking mode where the store keeps none, and still refuses a decision (501)', async () => {
  const actor = { id: 'a' };
  const inner = new InMemoryAgentStore();
  // A custom store without the proposal capability: it can only ever run blocking approvals.
  const store = Object.assign(Object.create(inner) as InMemoryAgentStore, {
    getThreadActionProposalScope: undefined,
    listActionProposals: undefined,
  });
  const module = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        store,
        actorResolver: { resolve: () => actor },
        model: new FakeModelProvider(() => ({ text: 'ok' })),
      }),
    ],
  }).compile();
  const app = module.createNestApplication<NestExpressApplication>();
  await app.init();
  try {
    const server = app.getHttpServer();
    const list = await request(server).get('/agent/threads/t1/action-proposals').expect(200);
    expect(list.body).toEqual([]);
    expect(list.headers['x-action-proposals-next']).toBeUndefined();
    await request(server)
      .post('/agent/threads/t1/action-proposals/p1/approve')
      .send({})
      .expect(501);
    // In process too: blocking mode has no proposals to list, rather than a 404.
    const { AgentService } = await import('../agent.service.js');
    expect(await app.get(AgentService).listActionProposals(actor, 't1')).toEqual([]);
  } finally {
    await app.close();
  }
});
