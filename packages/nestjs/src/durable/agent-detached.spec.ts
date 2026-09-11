import type { AgentStore, StoredMessage } from '@dudousxd/nestjs-agent-core';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
} from '@dudousxd/nestjs-agent-testing';
import { DurableModule, WorkflowService } from '@dudousxd/nestjs-durable';
import { InMemoryStateStore } from '@dudousxd/nestjs-durable-core';
import { EventEmitterTransport } from '@dudousxd/nestjs-durable-transport-event-emitter';
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentModule } from '../agent.module.js';
import { AgentService } from '../agent.service.js';
import { Agent } from '../decorator/agent.decorator.js';
import { AiTool } from '../decorator/ai-tool.decorator.js';
import { AgentDurableModule } from './agent-durable.module.js';

/** The one thing the research agent does — and it needs a human, so it parks. */
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

@Agent({ name: 'research', systemPrompt: 'research worker', tools: ['purgeCache'] })
@Injectable()
class ResearchAgent {}

@Agent({
  name: 'orch',
  systemPrompt: 'orchestrator',
  handoff: [{ agent: ResearchAgent, detached: true }],
})
@Injectable()
class OrchestratorAgent {}

/**
 * The orchestrator delegates on its first turn and then answers from whatever came back; the
 * research agent calls its action tool and then answers. `system` tells them apart, since both run
 * the same fake provider.
 */
const script: FakeScript = (args, turnIndex) => {
  if (args.system.includes('research worker')) {
    return turnIndex === 0
      ? { text: 'digging', toolCall: { name: 'purgeCache', input: { key: 'cfg' } } }
      : { text: 'RESEARCH ANSWER' };
  }
  if (turnIndex === 0) {
    return {
      text: 'starting',
      toolCall: { name: 'start_research', input: { task: 'dig into it' } },
    };
  }
  const results = (args.messages.at(-1)?.toolResults ?? []).map((result) => result.output);
  return { text: `orchestrator says: ${JSON.stringify(results)}` };
};

async function buildApp(store: AgentStore, chosen: FakeScript = script) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      DurableModule.forRoot({
        store: new InMemoryStateStore(),
        transport: new EventEmitterTransport(new EventEmitter2()),
      }),
      AgentModule.forRoot({
        model: new FakeModelProvider(chosen),
        store,
        durable: true,
        defaultAgent: 'orch',
        dispatchedSteps: false,
      }),
      AgentDurableModule,
    ],
    providers: [PurgeCacheTool, ResearchAgent, OrchestratorAgent],
  }).compile();
  await moduleRef.init();
  return {
    moduleRef,
    service: moduleRef.get(AgentService),
    workflows: moduleRef.get(WorkflowService),
  };
}

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of iterable) {
    out += decoder.decode(chunk);
  }
  return out;
}

/** Poll until `read` returns something, so a test never races the detached run it is waiting on. */
async function eventually<T>(read: () => Promise<T | undefined>, label: string): Promise<T> {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const value = await read();
    if (value !== undefined) {
      return value;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`timed out waiting for ${label}`);
}

describe('a detached delegation under the durable runner', () => {
  it('ends the turn while the sub-agent is still parked, then delivers its answer into the thread', async () => {
    const store = new InMemoryAgentStore();
    const { moduleRef, service, workflows } = await buildApp(store);
    try {
      const actor = { id: 'u1', roles: ['ADMIN'] };
      const { runId, threadId } = await service.chat({ actor, message: 'look into this' });
      const collected = collect(service.subscribe(runId));

      // THE TURN ENDS WITHOUT THE ANSWER. The research agent is still suspended on its approval.
      const parent = await workflows.waitForRun(runId, { timeoutMs: 5000 });
      const streamed = await collected;
      expect(parent.status).toBe('completed');
      expect(streamed).toContain('"status":"started"');
      expect(streamed).not.toContain('RESEARCH ANSWER');

      const before = await store.getThread(threadId);
      expect(before?.messages.map((message) => message.content)).not.toContain('RESEARCH ANSWER');
      // The sub-agent's pending approval did NOT hijack the finished turn's stream.
      expect(streamed).not.toContain('purgeCache');

      // It is waiting on a person, on its OWN run — which is what routes the decision back to it.
      const pending = await eventually(
        async () => store.toolCallRows().find((row) => row.toolName === 'purgeCache'),
        'the sub-agent to park on its action tool',
      );
      expect(pending.status).toBe('pending_approval');
      const childRunId = pending.runId;
      expect(childRunId).toBeDefined();
      expect(childRunId).not.toBe(runId);

      await service.approve(actor, pending.toolCallId);
      await workflows.waitForRun(childRunId ?? '', { timeoutMs: 5000 });

      // THE RESULT ARRIVES AFTERWARDS, IN THE RIGHT THREAD, UNDER ITS OWN NAME.
      const delivered = await eventually<StoredMessage>(
        async () =>
          (await store.getThread(threadId))?.messages.find(
            (message) => message.content === 'RESEARCH ANSWER',
          ),
        'the detached answer to be delivered',
      );
      expect(delivered).toMatchObject({
        role: 'assistant',
        runId: childRunId,
        agentName: 'research',
      });

      const receipt = store.toolCallRows().find((row) => row.toolName === 'start_research');
      expect(receipt?.output).toMatchObject({
        detached: true,
        status: 'delivered',
        agent: 'research',
        runId: childRunId,
        text: 'RESEARCH ANSWER',
      });
    } finally {
      await moduleRef.close();
    }
  });

  it('lets the owner attach to the detached run’s own stream', async () => {
    const store = new InMemoryAgentStore();
    const { moduleRef, service, workflows } = await buildApp(store);
    try {
      const actor = { id: 'u1', roles: ['ADMIN'] };
      const { runId } = await service.chat({ actor, message: 'look into this' });
      await collect(service.subscribe(runId));
      await workflows.waitForRun(runId, { timeoutMs: 5000 });

      const childRunId = await eventually(
        async () => store.toolCallRows().find((row) => row.toolName === 'purgeCache')?.runId,
        'the detached run to park',
      );
      // Its tokens are on a stream of its own, which the person who started it may read — the only
      // way a client can show a background agent working rather than a frozen card.
      await expect(service.subscribeAs(actor, childRunId)).resolves.toBeDefined();
      await expect(service.subscribeAs({ id: 'intruder' }, childRunId)).rejects.toThrow();
    } finally {
      await moduleRef.close();
    }
  });

  it('records the delegating run as the detached child’s parent', async () => {
    const store = new InMemoryAgentStore();
    const { moduleRef, service, workflows } = await buildApp(store);
    const parents: Record<string, string | undefined> = {};
    const recordRunStart = store.recordRunStart.bind(store);
    (store as AgentStore).recordRunStart = async (run) => {
      parents[run.runId] = run.parentRunId;
      await recordRunStart(run);
    };
    try {
      const actor = { id: 'u1', roles: ['ADMIN'] };
      const { runId } = await service.chat({ actor, message: 'look into this' });
      await collect(service.subscribe(runId));
      await workflows.waitForRun(runId, { timeoutMs: 5000 });

      const child = await eventually(
        async () => store.toolCallRows().find((row) => row.toolName === 'purgeCache')?.runId,
        'the detached run to start',
      );
      expect(parents[runId]).toBeUndefined();
      expect(parents[child]).toBe(runId);
    } finally {
      await moduleRef.close();
    }
  });

  it('tells the thread when the detached run dies instead of leaving it "started" for ever', async () => {
    const store = new InMemoryAgentStore();
    const dying: FakeScript = (args, turnIndex) => {
      if (args.system.includes('research worker')) {
        throw new Error('model unavailable');
      }
      return turnIndex === 0
        ? { text: 'starting', toolCall: { name: 'start_research', input: { task: 'dig' } } }
        : { text: 'started it' };
    };
    const { moduleRef, service, workflows } = await buildApp(store, dying);
    try {
      const actor = { id: 'u1', roles: ['ADMIN'] };
      const { runId, threadId } = await service.chat({ actor, message: 'look into this' });
      await collect(service.subscribe(runId));
      // The delegating turn is unaffected by its delegate's death — it never waited for it.
      expect((await workflows.waitForRun(runId, { timeoutMs: 5000 })).status).toBe('completed');

      const told = await eventually<StoredMessage>(
        async () =>
          (await store.getThread(threadId))?.messages.find((message) =>
            message.content.includes('stopped before it could answer'),
          ),
        'the failure to reach the thread',
      );
      expect(told.agentName).toBe('research');
      expect(told.content).toContain('model unavailable');
      expect(
        store.toolCallRows().find((row) => row.toolName === 'start_research')?.output,
      ).toMatchObject({ detached: true, status: 'failed', agent: 'research' });
    } finally {
      await moduleRef.close();
    }
  });
});
