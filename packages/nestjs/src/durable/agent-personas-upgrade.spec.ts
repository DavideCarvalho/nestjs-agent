// A run parked BEFORE personas existed, replayed AFTER the upgrade — on the code that is actually in
// production. Phase one runs `@dudousxd/nestjs-agent@1.19.3` (installed under the
// `nestjs-agent-before` alias): it starts a durable turn and leaves it parked on a person's approval.
// Phase two is a fresh app over the same journal and store running THIS code, with the agent now
// declaring personas — what a deploy is. Every position the old code recorded must be asked for again,
// in order, under the same name, or the engine refuses the run as non-deterministic.
import type { ModelProvider, ModelTurnArgs, ModelTurnResult } from '@dudousxd/nestjs-agent-core';
import { InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { DurableModule } from '@dudousxd/nestjs-durable';
import { InMemoryStateStore, WorkflowEngine } from '@dudousxd/nestjs-durable-core';
import { EventEmitterTransport } from '@dudousxd/nestjs-durable-transport-event-emitter';
import { Injectable } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import * as before from 'nestjs-agent-before';
import * as beforeDurable from 'nestjs-agent-before/durable';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentModule } from '../agent.module.js';
import { AgentService } from '../agent.service.js';
import { Agent } from '../decorator/agent.decorator.js';
import { AiTool } from '../decorator/ai-tool.decorator.js';
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';
import { AgentDurableModule } from './agent-durable.module.js';

const ACTOR = { id: 'u1', roles: ['ADMIN'] };

// Decorated for both releases: the tool metadata key is per-copy, the agent's is global.
@before.AiTool({ name: 'publish', kind: 'action', description: 'publish', input: z.object({}) })
@AiTool({ name: 'publish', kind: 'action', description: 'publish', input: z.object({}) })
@Injectable()
class PublishTool {
  static runs = 0;
  async execute(): Promise<{ published: boolean }> {
    PublishTool.runs += 1;
    return { published: true };
  }
}

/** One action call, then a plain answer. Records the prompt of every call it serves. */
class ActionModel implements ModelProvider {
  readonly prompts: string[] = [];

  async runTurn(args: ModelTurnArgs): Promise<ModelTurnResult> {
    this.prompts.push(args.system);
    const turn = args.messages.filter((message) => message.role === 'assistant').length;
    const text = turn === 0 ? 'about to publish' : 'published';
    await args.sink.write(new TextEncoder().encode(text));
    return {
      text,
      toolCalls: turn === 0 ? [{ id: 'call-publish', name: 'publish', input: {} }] : [],
      usage: { inputTokens: 1, outputTokens: 1 },
    };
  }
}

interface Shared {
  stateStore: InMemoryStateStore;
  agentStore: InMemoryAgentStore;
  model: ActionModel;
}

function fresh(): Shared {
  return {
    stateStore: new InMemoryStateStore(),
    agentStore: new InMemoryAgentStore(),
    model: new ActionModel(),
  };
}

/** The release before personas: two separate agents, as an app modelled its variants then. */
async function buildBefore(shared: Shared) {
  @Agent({ name: 'default', systemPrompt: 'Base prompt.', model: 'fake-1' })
  @Injectable()
  class DefaultAgent {}

  @Agent({ name: 'publisher', systemPrompt: 'Publisher prompt.', model: 'fake-1' })
  @Injectable()
  class PublisherAgent {}

  const moduleRef = await Test.createTestingModule({
    imports: [
      DurableModule.forRoot({
        store: shared.stateStore,
        transport: new EventEmitterTransport(new EventEmitter2()),
      }),
      before.AgentModule.forRoot({
        model: shared.model,
        store: shared.agentStore,
        actorResolver: new before.HeaderActorResolver(),
        durable: true,
        defaultAgent: 'default',
      } as never),
      beforeDurable.AgentDurableModule,
    ],
    providers: [PublishTool, DefaultAgent, PublisherAgent],
  }).compile();
  await moduleRef.init();
  return { moduleRef, service: moduleRef.get(before.AgentService) };
}

/** This release: `publisher` folded into `default` as a persona that answers for the old name. */
async function buildAfter(shared: Shared) {
  @Agent({
    name: 'default',
    systemPrompt: 'Base prompt.',
    model: 'fake-1',
    defaultPersona: 'general',
    personas: [
      { id: 'general', label: 'General' },
      {
        id: 'publisher',
        label: 'Publisher',
        systemPrompt: 'Publisher prompt.',
        aliases: ['publisher'],
      },
    ],
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
    providers: [PublishTool, DefaultAgent],
  }).compile();
  await moduleRef.init();
  return moduleRef;
}

async function parked(store: InMemoryAgentStore): Promise<void> {
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (store.toolCallRows()[0]?.status === 'pending_approval') {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error('the turn never parked its action tool on an approval');
}

async function journal(store: InMemoryStateStore, runId: string): Promise<string[]> {
  return (await store.listCheckpoints(runId))
    .sort((left, right) => left.seq - right.seq)
    .map((checkpoint) => checkpoint.name);
}

async function parkOnBefore(shared: Shared, agentName: string): Promise<string> {
  const { moduleRef, service } = await buildBefore(shared);
  try {
    const { runId } = await service.chat({ actor: ACTOR, message: 'go', agentName });
    await parked(shared.agentStore);
    return runId;
  } finally {
    await moduleRef.close();
  }
}

async function approveOnAfter(shared: Shared, runId: string): Promise<void> {
  const after = await buildAfter(shared);
  try {
    await after.get(AgentService).approve(ACTOR, 'call-publish');
    const result = await after
      .get(WorkflowEngine)
      .waitForRun(runId, { timeoutMs: 5000, until: 'terminal' });
    expect(result.status).toBe('completed');
  } finally {
    await after.close();
  }
}

describe('personas — a run parked before the upgrade', () => {
  it('phase one really is the release without personas', () => {
    // Loaded from node_modules (externalized, so Node — not the workspace alias — resolves it and the
    // `@dudousxd/nestjs-agent-core` it ships with).
    const factory = (before as unknown as { AgentDepsFactory: { prototype: object } })
      .AgentDepsFactory;
    expect('resolvePersona' in factory.prototype).toBe(false);
  });

  it('replays on the sequence it recorded once its agent declares personas and a default', async () => {
    PublishTool.runs = 0;
    const shared = fresh();
    const runId = await parkOnBefore(shared, 'default');

    await approveOnAfter(shared, runId);

    expect(PublishTool.runs).toBe(1);
    expect(shared.agentStore.toolCallRows()[0]).toMatchObject({ status: 'executed' });
    // The run named no persona when it started, so it spends no position on one now…
    expect(await journal(shared.stateStore, runId)).not.toContain('persona:resolve');
    // …and its resumed model call runs on the agent's own prompt, not the new default persona's.
    expect(shared.model.prompts).toEqual(['Base prompt.', 'Base prompt.']);
  });

  it('finishes a run journaled under an agent that is now a persona of another', async () => {
    PublishTool.runs = 0;
    const shared = fresh();
    const runId = await parkOnBefore(shared, 'publisher');

    await approveOnAfter(shared, runId);

    expect(PublishTool.runs).toBe(1);
    expect(await journal(shared.stateStore, runId)).not.toContain('persona:resolve');
    // The old agent name now resolves to the persona that took it over — same prompt as before.
    expect(shared.model.prompts).toEqual(['Publisher prompt.', 'Publisher prompt.']);
  });
});
