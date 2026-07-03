import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
} from '@dudousxd/nestjs-agent-testing';
import { DurableModule, WorkflowService } from '@dudousxd/nestjs-durable';
import { InMemoryStateStore } from '@dudousxd/nestjs-durable-core';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { z } from 'zod';
import { describe, expect, it } from 'vitest';
import { AgentModule } from '../agent.module.js';
import { AgentService } from '../agent.service.js';
import { AiTool } from '../decorator/ai-tool.decorator.js';
import { AgentDurableModule } from './agent-durable.module.js';

@AiTool({ name: 'purgeCache', kind: 'action', description: 'purge', input: z.object({ key: z.string() }) })
@Injectable()
class PurgeCacheTool {
  async execute(input: { key: string }) {
    return { purged: input.key };
  }
}

async function buildDurableApp(script: FakeScript) {
  const store = new InMemoryAgentStore();
  const moduleRef = await Test.createTestingModule({
    imports: [
      DurableModule.forRoot({ store: new InMemoryStateStore() }),
      AgentModule.forRoot({
        model: new FakeModelProvider(script),
        store,
        durable: true,
        defaultAgent: { modelId: 'fake-1', systemPrompt: 'durable test agent' },
      }),
      AgentDurableModule,
    ],
    providers: [PurgeCacheTool],
  }).compile();
  await moduleRef.init();
  return {
    moduleRef,
    store,
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

describe('durable wiring', () => {
  it('throws a clear error when durable:true but AgentDurableModule is missing', async () => {
    const build = Test.createTestingModule({
      imports: [
        DurableModule.forRoot({ store: new InMemoryStateStore() }),
        AgentModule.forRoot({
          model: new FakeModelProvider(() => ({ text: 'x' })),
          store: new InMemoryAgentStore(),
          durable: true,
          // AgentDurableModule intentionally NOT imported
        }),
      ],
    }).compile();
    await expect(build).rejects.toThrow(/requires importing AgentDurableModule/);
  });
});

describe('AgentDurableModule (the agent turn as a durable workflow)', () => {
  it('runs a no-tool turn as a durable run and streams it', async () => {
    const { moduleRef, service, workflows, store } = await buildDurableApp(() => ({ text: 'hello durable' }));
    try {
      const { runId } = await service.chat({ actor: { id: 'u1', roles: ['ADMIN'] }, message: 'hi' });
      const collected = collect(service.subscribe(runId));
      const result = await workflows.waitForRun(runId, { timeoutMs: 5000 });
      const streamed = await collected;

      expect(result.status).toBe('completed');
      expect(streamed).toContain('hello durable');
      const detail = await store.getThread((await store.listThreads('u1'))[0]?.id ?? '');
      expect(detail?.messages.map((m) => m.role)).toContain('assistant');
    } finally {
      await moduleRef.close();
    }
  });

  it('suspends on an action tool (waitForSignal) and resumes on approve signal', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'about to purge', toolCall: { name: 'purgeCache', input: { key: 'cfg' } } }
        : { text: 'purged durably' };
    const { moduleRef, service, workflows, store } = await buildDurableApp(script);
    try {
      const { runId } = await service.chat({ actor: { id: 'u1', roles: ['ADMIN'] }, message: 'purge it' });
      const collected = collect(service.subscribe(runId));

      await new Promise((resolve) => setTimeout(resolve, 50));
      await service.approve(runId, 'call-0-purgeCache');

      const result = await workflows.waitForRun(runId, { timeoutMs: 5000 });
      const streamed = await collected;

      expect(result.status).toBe('completed');
      expect(streamed).toContain('purged durably');
      expect(store.toolCallRows()[0]).toMatchObject({ toolName: 'purgeCache', status: 'executed' });
    } finally {
      await moduleRef.close();
    }
  });
});
