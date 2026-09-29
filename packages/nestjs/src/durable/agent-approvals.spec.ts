import type { ApprovalPolicy } from '@dudousxd/nestjs-agent-core';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
} from '@dudousxd/nestjs-agent-testing';
import { DurableModule } from '@dudousxd/nestjs-durable';
import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { EventEmitterTransport } from '@dudousxd/nestjs-durable-transport-event-emitter';
import { ForbiddenException, GoneException, Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentModule } from '../agent.module.js';
import { AgentService } from '../agent.service.js';
import { Agent } from '../decorator/agent.decorator.js';
import { AiTool } from '../decorator/ai-tool.decorator.js';
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';
import { AgentDurableModule } from './agent-durable.module.js';

@AiTool({
  name: 'purgeCache',
  kind: 'action',
  description: 'purge',
  input: z.object({ key: z.string() }),
})
@Injectable()
class PurgeCacheTool {
  async execute(input: { key: string }) {
    return { purged: input.key };
  }
}

@Agent({ name: 'default', systemPrompt: 'durable approvals agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

const REQUESTER = { id: 'u1', roles: ['ADMIN'] };

/** A run's first step purges, its next one answers — however much history the thread holds. */
const purgeOnce: FakeScript = (args) =>
  args.messages.at(-1)?.role === 'user'
    ? { text: 'about to purge', toolCall: { name: 'purgeCache', input: { key: 'cfg' } } }
    : { text: 'finished' };

async function buildApp(approvalPolicy?: ApprovalPolicy) {
  const store = new InMemoryAgentStore();
  const moduleRef = await Test.createTestingModule({
    imports: [
      DurableModule.forRoot({
        store: new InMemoryStateStore(),
        transport: new EventEmitterTransport(new EventEmitter2()),
      }),
      AgentModule.forRoot({
        model: new FakeModelProvider(purgeOnce),
        store,
        actorResolver: new HeaderActorResolver(),
        durable: true,
        defaultAgent: 'default',
        ...(approvalPolicy !== undefined ? { approvalPolicy } : {}),
      }),
      AgentDurableModule,
    ],
    providers: [PurgeCacheTool, DefaultAgent],
  }).compile();
  await moduleRef.init();
  return {
    moduleRef,
    store,
    service: moduleRef.get(AgentService),
    engine: moduleRef.get(WorkflowEngine),
  };
}

async function pending(store: InMemoryAgentStore, index = 0): Promise<string> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const row = store.toolCallRows()[index];
    if (row?.status === 'pending_approval') {
      return row.toolCallId;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the turn never parked its action tool on an approval');
}

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of iterable) {
    out += decoder.decode(chunk);
  }
  return out;
}

describe('approvals v2 on the durable runner', () => {
  it('expires a request nobody decides, and tells the client and the model', async () => {
    const { moduleRef, store, service, engine } = await buildApp({
      requirementFor: () => ({ required: true, approver: 'requester', ttlMs: 150 }),
    });
    try {
      const { runId } = await service.chat({ actor: REQUESTER, message: 'purge it' });
      const streamed = collect(service.subscribe(runId));
      const callId = await pending(store);
      const result = await engine.waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });

      expect(result.status).toBe('completed');
      expect(store.toolCallRows()[0]).toMatchObject({ status: 'expired', approver: 'requester' });
      const frames = await streamed;
      expect(frames).toContain('"kind":"approval-requested"');
      expect(frames).toContain(`{"kind":"approval-settled","id":"${callId}","status":"expired"}`);
      expect(frames).toContain(
        `{"kind":"tool-output-denied","id":"${callId}","reason":"approval expired"}`,
      );
      // A decision arriving after the lapse is refused rather than signalled into the run.
      await expect(service.approve(REQUESTER, callId)).rejects.toBeInstanceOf(GoneException);
    } finally {
      await moduleRef.close();
    }
  });

  it('enforces a role approver, records who decided and through what, and remembers', async () => {
    const { moduleRef, store, service, engine } = await buildApp({
      requirementFor: () => ({ required: true, approver: 'ops' }),
    });
    try {
      const first = await service.chat({ actor: REQUESTER, message: 'purge it' });
      const callId = await pending(store);

      // The requester does not hold the role, so it is not theirs to approve.
      await expect(service.approve(REQUESTER, callId)).rejects.toBeInstanceOf(ForbiddenException);
      await service.approve({ id: 'op-1', roles: ['ops'] }, callId, {
        remember: true,
        via: 'slack',
      });
      await engine.waitForRun(first.runId, { timeoutMs: 5000, until: 'terminal' });
      expect(store.toolCallRows()[0]).toMatchObject({
        status: 'executed',
        approver: 'ops',
        executedByRef: 'op-1',
        decidedVia: 'slack',
        remember: true,
      });

      // The same tool, the same thread: approved by the remembered decision, never parked.
      const threadId = (await store.listThreads('u1'))[0]?.id ?? '';
      const second = await service.chat({ actor: REQUESTER, message: 'again', threadId });
      const result = await engine.waitForRun(second.runId, { timeoutMs: 5000, until: 'terminal' });
      expect(result.status).toBe('completed');
      expect(store.toolCallRows()[1]).toMatchObject({
        status: 'executed',
        approver: 'ops',
        decidedVia: 'remembered',
      });
    } finally {
      await moduleRef.close();
    }
  });
});
