// A persona is resolved ONCE per run, in the `persona:resolve` checkpoint, and every replay reads it
// back. These tests hold that line on the durable runner: a turn parks on a person's approval, the
// persona's config is rewritten (then removed) by the process that resumes it, and the turn still
// finishes on the prompt and allow-list it started with.
import type {
  ModelProvider,
  ModelTurnArgs,
  ModelTurnResult,
  Persona,
} from '@dudousxd/nestjs-agent-core';
import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { DurableModule } from '@dudousxd/nestjs-durable';
import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
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
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';
import { AgentDurableModule } from './agent-durable.module.js';

const ACTOR = { id: 'u1', roles: ['ADMIN'] };

@AiTool({ name: 'publish', kind: 'action', description: 'publish', input: z.object({}) })
@Injectable()
class PublishTool {
  static runs = 0;
  async execute(): Promise<{ published: boolean }> {
    PublishTool.runs += 1;
    return { published: true };
  }
}

@AiTool({ name: 'lookup', kind: 'read', description: 'lookup', input: z.object({}) })
@Injectable()
class LookupTool {
  async execute(): Promise<{ found: boolean }> {
    return { found: true };
  }
}

/** Two action calls — two approvals, so the run parks twice — then a plain answer. */
class TwoApprovalsModel implements ModelProvider {
  readonly calls: Array<{ system: string; tools: string[] }> = [];

  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    this.calls.push({ system: args.system, tools: args.tools.map((tool) => tool.name) });
    const turn = args.messages.filter((message) => message.role === 'assistant').length;
    const text = turn < 2 ? `publishing ${turn}` : 'published twice';
    await args.sink.write(new TextEncoder().encode(text));
    return {
      text,
      toolCalls: turn < 2 ? [{ id: `call-publish-${turn}`, name: 'publish', input: {} }] : [],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

interface Shared {
  stateStore: InMemoryStateStore;
  agentStore: InMemoryAgentStore;
  model: TwoApprovalsModel;
}

/** The `careful` persona as each deployment declares it — `undefined` → the persona is gone. */
async function buildApp(shared: Shared, careful: Persona | undefined) {
  @Agent({
    name: 'default',
    systemPrompt: 'Base prompt.',
    model: 'fake-1',
    ...(careful !== undefined ? { personas: [careful] } : {}),
  })
  @Injectable()
  class DefaultAgent {}

  const moduleRef = await Test.createTestingModule({
    imports: [
      DurableModule.forRoot({
        store: shared.stateStore,
        transport: new EventEmitterTransport(new EventEmitter2()),
      }),
      AgentModule.forRoot({
        model: shared.model,
        store: shared.agentStore,
        actorResolver: new HeaderActorResolver(),
        durable: true,
        defaultAgent: 'default',
      }),
      AgentDurableModule,
    ],
    providers: [PublishTool, LookupTool, DefaultAgent],
  }).compile();
  await moduleRef.init();
  return moduleRef;
}

async function pending(store: InMemoryAgentStore, toolCallId: string): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    const row = store.toolCallRows().find((candidate) => candidate.toolCallId === toolCallId);
    if (row?.status === 'pending_approval') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`${toolCallId} never parked on an approval`);
}

async function journal(store: InMemoryStateStore, runId: string): Promise<string[]> {
  return (await store.listCheckpoints(runId))
    .sort((left, right) => left.seq - right.seq)
    .map((checkpoint) => checkpoint.name);
}

describe('a persona under the durable runner', () => {
  it('resumes between signals on the persona it started with, whatever the config says now', async () => {
    PublishTool.runs = 0;
    const shared: Shared = {
      stateStore: new InMemoryStateStore(),
      agentStore: new InMemoryAgentStore(),
      model: new TwoApprovalsModel(),
    };

    // Phase one: the persona as first deployed. The turn parks on its first approval.
    const first = await buildApp(shared, {
      id: 'careful',
      label: 'Careful',
      systemPrompt: 'Careful v1.',
      allowedTools: ['publish'],
    });
    let runId: string;
    let threadId: string;
    try {
      ({ runId, threadId } = await first
        .get(AgentService)
        .chat({ actor: ACTOR, message: 'publish it', personaId: 'careful' }));
      await pending(shared.agentStore, 'call-publish-0');
      expect(await journal(shared.stateStore, runId)).toContain('persona:resolve');
    } finally {
      await first.close();
    }

    // Phase two: the persona was rewritten — another prompt, and `publish` taken off its list.
    const second = await buildApp(shared, {
      id: 'careful',
      label: 'Careful',
      systemPrompt: 'Careful v2.',
      allowedTools: ['lookup'],
    });
    try {
      await second.get(AgentService).approve(ACTOR, 'call-publish-0');
      await pending(shared.agentStore, 'call-publish-1');
    } finally {
      await second.close();
    }

    // Phase three: the persona is gone altogether.
    const third = await buildApp(shared, undefined);
    try {
      await third.get(AgentService).approve(ACTOR, 'call-publish-1');
      const result = await third
        .get(WorkflowEngine)
        .waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
      expect(result.status).toBe('completed');
    } finally {
      await third.close();
    }

    // Every model call — before and after both resumes — ran on the recorded prompt and offer.
    expect(shared.model.calls.map((call) => call.system)).toEqual([
      'Careful v1.',
      'Careful v1.',
      'Careful v1.',
    ]);
    expect(shared.model.calls.every((call) => call.tools.join() === 'publish')).toBe(true);
    // Both approved calls ran, once each, though the live config no longer allowed `publish`.
    expect(PublishTool.runs).toBe(2);
    const messages = (await shared.agentStore.getThread(threadId))?.messages ?? [];
    expect(
      messages.filter((message) => message.role === 'assistant').map((m) => m.persona),
    ).toEqual(['careful', 'careful', 'careful']);
    expect(
      (await journal(shared.stateStore, runId)).filter((name) => name === 'persona:resolve'),
    ).toHaveLength(1);
  });
});
