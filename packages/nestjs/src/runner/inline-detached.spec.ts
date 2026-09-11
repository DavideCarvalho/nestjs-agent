import type { AgentStore, StoredMessage } from '@dudousxd/nestjs-agent-core';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
} from '@dudousxd/nestjs-agent-testing';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentModule } from '../agent.module.js';
import { AgentService } from '../agent.service.js';
import { Agent } from '../decorator/agent.decorator.js';
import { AiTool } from '../decorator/ai-tool.decorator.js';

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

const script: FakeScript = (args, turnIndex) => {
  if (args.system.includes('research worker')) {
    return turnIndex === 0
      ? { text: 'digging', toolCall: { name: 'purgeCache', input: { key: 'cfg' } } }
      : { text: 'RESEARCH ANSWER' };
  }
  return turnIndex === 0
    ? { text: 'starting', toolCall: { name: 'start_research', input: { task: 'dig into it' } } }
    : { text: 'started it' };
};

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of iterable) {
    out += decoder.decode(chunk);
  }
  return out;
}

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

describe('a detached delegation under the inline runner', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function buildApp(store: AgentStore) {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AgentModule.forRoot({
          model: new FakeModelProvider(script),
          store,
          defaultAgent: 'orch',
        }),
      ],
      providers: [PurgeCacheTool, ResearchAgent, OrchestratorAgent],
    }).compile();
    await moduleRef.init();
    close = () => moduleRef.close();
    return moduleRef.get(AgentService);
  }

  it('ends the turn, keeps the sub-agent running, and delivers its answer afterwards', async () => {
    const store: AgentStore = new InMemoryAgentStore();
    const service = await buildApp(store);
    const actor = { id: 'u1', roles: ['ADMIN'] };

    const { runId, threadId } = await service.chat({ actor, message: 'look into this' });
    const streamed = await collect(service.subscribe(runId));

    // The turn is over — its stream carried a receipt, never the delegate's answer.
    expect(streamed).toContain('"status":"started"');
    expect(streamed).toContain('started it');
    expect(streamed).not.toContain('RESEARCH ANSWER');

    const rows = (store as InMemoryAgentStore).toolCallRows();
    const pending = await eventually(
      async () =>
        (store as InMemoryAgentStore)
          .toolCallRows()
          .find((row) => row.toolName === 'purgeCache' && row.status === 'pending_approval'),
      'the sub-agent to park on its action tool',
    );
    expect(rows.find((row) => row.toolName === 'start_research')?.status).toBe('executed');
    expect(pending.runId).not.toBe(runId);

    await service.approve(actor, pending.toolCallId);

    const delivered = await eventually<StoredMessage>(
      async () =>
        (await store.getThread(threadId))?.messages.find(
          (message) => message.content === 'RESEARCH ANSWER',
        ),
      'the detached answer to be delivered',
    );
    expect(delivered).toMatchObject({
      role: 'assistant',
      runId: pending.runId,
      agentName: 'research',
    });
  });

  it('tells the thread when someone stops the background agent', async () => {
    const store: AgentStore = new InMemoryAgentStore();
    const service = await buildApp(store);
    const actor = { id: 'u1', roles: ['ADMIN'] };

    const { runId, threadId } = await service.chat({ actor, message: 'look into this' });
    await collect(service.subscribe(runId));

    const pending = await eventually(
      async () =>
        (store as InMemoryAgentStore)
          .toolCallRows()
          .find((row) => row.toolName === 'purgeCache' && row.status === 'pending_approval'),
      'the sub-agent to park on its action tool',
    );
    // A background run nobody ever approves is stoppable on its own id — which the receipt carries.
    await service.cancel(actor, pending.runId ?? '');

    const told = await eventually<StoredMessage>(
      async () =>
        (await store.getThread(threadId))?.messages.find((message) =>
          message.content.includes('was stopped before it could answer'),
        ),
      'the cancellation to reach the thread',
    );
    expect(told.agentName).toBe('research');
    expect(
      (store as InMemoryAgentStore).toolCallRows().find((row) => row.toolName === 'start_research')
        ?.output,
    ).toMatchObject({ detached: true, status: 'cancelled' });
  });
});
