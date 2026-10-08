import { InMemoryAgentStore, type ToolPreflightResult } from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider, InMemoryGovernanceQueries } from '@dudousxd/nestjs-agent-testing';
import { Injectable } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { AgentModule } from '../agent.module.js';
import { AiTool } from '../decorator/ai-tool.decorator.js';

/**
 * Independent approvals, configured the way a host app runs them (every `action` tool proposed,
 * approved by the requester, lapsing after a TTL, a background worker executing approved work).
 * The turn records the call as `proposed` and ends; the call's record then has to follow the
 * proposal — the dashboard's tool-call list reads it, and used to show an executed, rejected or
 * expired action as PROPOSED forever.
 */

@AiTool({
  name: 'refund',
  kind: 'action',
  description: 'Refund an order',
  input: z.object({ amount: z.number().default(5) }),
})
@Injectable()
class RefundTool {
  preflight(input: { amount: number }): ToolPreflightResult {
    return { status: 'ready', confirmation: { title: `Refund ${input.amount}`, verb: 'Refund' } };
  }
  async execute(input: { amount: number }) {
    if (input.amount < 0) throw new Error('negative refund');
    return { refunded: input.amount };
  }
}

let app: NestExpressApplication | undefined;
afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function boot(options: { ttlMs?: number; amount?: number } = {}) {
  const actor = { id: 'a' };
  const store = new InMemoryAgentStore();
  const thread = await store.createThread({ actor });
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        store,
        actionApprovalMode: 'independent',
        actorResolver: { resolve: () => actor },
        backgroundActorResolver: { resolve: async () => actor },
        actionProposalWorker: { pollIntervalMs: 20, leaseMs: 30_000 },
        approvalPolicy: {
          requirementFor: (tool) => ({
            required: tool.kind === 'action',
            approver: 'requester',
            ttlMs: options.ttlMs ?? 5 * 60_000,
          }),
        },
        model: new FakeModelProvider((args) =>
          args.messages.at(-1)?.content === 'refund'
            ? {
                text: 'Prepared',
                toolCall: { name: 'refund', input: { amount: options.amount ?? 5 } },
              }
            : { text: 'Done' },
        ),
      }),
    ],
    providers: [RefundTool],
  }).compile();
  app = moduleRef.createNestApplication<NestExpressApplication>();
  await app.init();
  const server = app.getHttpServer();
  await request(server)
    .post('/agent/chat')
    .send({ threadId: thread.id, message: 'refund' })
    .expect(201);
  const scope = { threadId: thread.id, actorRef: 'a', tenantRef: null };
  const [proposal] = await store.listActionProposals(scope);
  if (proposal === undefined) throw new Error('no proposal');
  const dashboard = new InMemoryGovernanceQueries(store);
  /** The status the dashboard's tool-call list shows for the proposed call. */
  const shown = async () =>
    (await dashboard.recentToolCalls(10)).find(
      (row) => row.toolCallId === proposal.originToolCallId,
    )?.status;
  return { server, store, thread, proposal, shown };
}

describe('independent approvals — the tool-call record follows its proposal', () => {
  it('shows PROPOSED, then EXECUTED with the output once the approved action ran', async () => {
    const { server, store, thread, proposal, shown } = await boot();
    expect(await shown()).toBe('proposed');

    await request(server)
      .post(`/agent/threads/${thread.id}/action-proposals/${proposal.id}/approve`)
      .send({})
      .expect(201);

    await vi.waitFor(async () => expect(await shown()).toBe('executed'), { timeout: 3000 });
    const [outcome] = await store.toolCallOutcomes([proposal.originToolCallId]);
    expect(outcome).toMatchObject({ status: 'executed', output: { refunded: 5 } });
  });

  it('shows FAILED with the error when the approved action throws', async () => {
    const { server, store, thread, proposal, shown } = await boot({ amount: -1 });

    await request(server)
      .post(`/agent/threads/${thread.id}/action-proposals/${proposal.id}/approve`)
      .send({})
      .expect(201);

    await vi.waitFor(async () => expect(await shown()).toBe('failed'), { timeout: 3000 });
    const [outcome] = await store.toolCallOutcomes([proposal.originToolCallId]);
    expect(outcome?.error).toMatch(/negative refund/);
  });

  it('shows REJECTED once the proposal is rejected', async () => {
    const { server, thread, proposal, shown } = await boot();

    await request(server)
      .post(`/agent/threads/${thread.id}/action-proposals/${proposal.id}/reject`)
      .send({})
      .expect(201);

    expect(await shown()).toBe('rejected');
  });

  it('shows EXPIRED once the proposal lapses undecided', async () => {
    const { shown } = await boot({ ttlMs: 50 });
    expect(await shown()).toBe('proposed');

    // The worker's sweep expires it.
    await vi.waitFor(async () => expect(await shown()).toBe('expired'), { timeout: 3000 });
  });
});
