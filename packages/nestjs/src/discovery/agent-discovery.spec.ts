import type { Actor, ModelTurnArgs } from '@dudousxd/nestjs-agent-core';
import type { PromptContext } from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { describe, expect, it } from 'vitest';
import { AgentModule } from '../agent.module.js';
import { AgentService } from '../agent.service.js';
import { Agent } from '../decorator/agent.decorator.js';
import { SystemPrompt, SystemPromptContributor } from '../decorator/system-prompt.decorator.js';
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';

@Injectable()
class SchemaService {
  describe(): string {
    return 'tables: units';
  }
}

@Agent({ name: 'concierge', model: 'fake-1' })
@Injectable()
class ConciergeAgent {
  constructor(private readonly schema: SchemaService) {}

  @SystemPrompt()
  buildPrompt(ctx: PromptContext): string {
    return `Concierge for ${ctx.actor.id}. Schema: ${this.schema.describe()}`;
  }
}

@Injectable()
class BaseScopeContributor {
  @SystemPromptContributor()
  contribute(ctx: PromptContext): string | null {
    return ctx.actor.tenantRef === undefined ? null : `Scoped to base ${ctx.actor.tenantRef}.`;
  }
}

@Injectable()
class NoopContributor {
  @SystemPromptContributor()
  contribute(): string | null {
    return null;
  }
}

async function buildApp() {
  const captured: string[] = [];
  const model = new FakeModelProvider((args: ModelTurnArgs) => {
    captured.push(args.system);
    return { text: 'answer' };
  });
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model,
        store: new InMemoryAgentStore(),
        actorResolver: new HeaderActorResolver(),
      }),
    ],
    providers: [SchemaService, ConciergeAgent, BaseScopeContributor, NoopContributor],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return { app, agent: app.get(AgentService), captured };
}

async function runTurn(agent: AgentService, actor: Actor): Promise<string> {
  const { runId, threadId } = await agent.chat({ actor, message: 'hi' });
  for await (const _chunk of agent.subscribe(runId)) {
    // drain to completion so the inline run finishes
  }
  return threadId;
}

describe('AgentDiscoveryService', () => {
  it('composes the @SystemPrompt base with @SystemPromptContributor sections, skipping null', async () => {
    const { app, agent, captured } = await buildApp();
    const actor: Actor = { id: 'u-1', roles: ['ADMIN'], tenantRef: 'base-42' };

    await runTurn(agent, actor);

    const system = captured[0] ?? '';
    // @SystemPrompt method ran (with its injected SchemaService):
    expect(system).toContain('Concierge for u-1');
    expect(system).toContain('tables: units');
    // the base-scope contributor appended its section:
    expect(system).toContain('Scoped to base base-42.');
    // the null contributor left no empty gap:
    expect(system).not.toContain('\n\n\n');

    await app.close();
  });

  it('stamps the resolved agent name on the assistant message, and a contributor that returns null contributes nothing', async () => {
    const { app, agent, captured } = await buildApp();
    const actor: Actor = { id: 'u-2', roles: ['ADMIN'] }; // no tenantRef → base-scope skips

    const threadId = await runTurn(agent, actor);

    expect(captured[0] ?? '').not.toContain('Scoped to base');
    const thread = await agent.getThread(actor, threadId);
    const assistant = thread?.messages.find((message) => message.role === 'assistant');
    expect(assistant?.agentName).toBe('concierge');

    await app.close();
  });
});
