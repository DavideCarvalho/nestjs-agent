import {
  AGENT_ROLES_POLICY,
  AGENT_TOOL_REGISTRY,
  type Actor,
  DefaultRolesPolicy,
  PERSONAL_AGENT_ROLE,
  type RolesPolicy,
  type ToolRegistry,
} from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentModule } from '../agent.module.js';
import { Agent } from '../decorator/agent.decorator.js';
import { AiTool } from '../decorator/ai-tool.decorator.js';
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';

/**
 * `isEnabled()` / `canUse()` live on the tool PROVIDER, while the registry holds a wrapper the
 * discovery service builds. These cover the forwarding: a gate that stayed behind on the provider
 * would be one an app declares, sees no error for, and that never runs — the worst shape a feature
 * flag or an entitlement check can fail in.
 */

/** Stands in for a config service / entitlement table — mutable, so a test can flip it live. */
@Injectable()
class Switchboard {
  featureOn = false;
  entitled = new Set<string>();
}

@AiTool({
  name: 'flaggedTool',
  kind: 'read',
  description: 'behind a deployment flag',
  input: z.object({}),
})
@Injectable()
class FlaggedTool {
  constructor(private readonly switchboard: Switchboard) {}

  isEnabled(): boolean {
    return this.switchboard.featureOn;
  }

  async execute() {
    return { ok: true };
  }
}

@AiTool({
  name: 'entitledTool',
  kind: 'read',
  description: 'per-user entitlement',
  input: z.object({}),
})
@Injectable()
class EntitledTool {
  constructor(private readonly switchboard: Switchboard) {}

  canUse(actor: Actor): boolean {
    return this.switchboard.entitled.has(actor.id);
  }

  async execute() {
    return { ok: true };
  }
}

@AiTool({
  name: 'staticallyOffTool',
  kind: 'read',
  description: 'off by decorator',
  input: z.object({}),
  enabled: false,
})
@Injectable()
class StaticallyOffTool {
  async execute() {
    return { ok: true };
  }
}

@AiTool({
  name: 'plainTool',
  kind: 'read',
  description: 'no gates of its own',
  input: z.object({}),
})
@Injectable()
class PlainTool {
  async execute() {
    return { ok: true };
  }
}

@Agent({ name: 'default', systemPrompt: 'test agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

async function build() {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model: new FakeModelProvider(() => ({ text: 'noop' })),
        store: new InMemoryAgentStore(),
        actorResolver: new HeaderActorResolver(),
        defaultAgent: 'default',
      }),
    ],
    providers: [Switchboard, FlaggedTool, EntitledTool, StaticallyOffTool, PlainTool, DefaultAgent],
  }).compile();
  const app = moduleRef.createNestApplication();
  await app.init();
  return {
    app,
    switchboard: app.get(Switchboard),
    registry: app.get<ToolRegistry>(AGENT_TOOL_REGISTRY),
  };
}

describe('AiToolDiscoveryService — availability gates on the provider', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  const actor: Actor = { id: 'u1', roles: ['ADMIN'] };
  const policy = new DefaultRolesPolicy();

  async function toolNames(registry: ToolRegistry, who: Actor = actor): Promise<string[]> {
    return (await registry.definitionsFor(who, policy)).map((definition) => definition.name).sort();
  }

  it("reads isEnabled() off the provider, with the provider's injected dependencies", async () => {
    const built = await build();
    close = () => built.app.close();

    // `entitledTool` is absent for a second reason (nobody is entitled yet) — covered below.
    expect(await toolNames(built.registry)).toEqual(['plainTool']);

    built.switchboard.featureOn = true;
    // No re-registration, no restart: the next turn asks the provider again.
    expect(await toolNames(built.registry)).toEqual(['flaggedTool', 'plainTool']);
  });

  it('reads canUse() off the provider, per actor', async () => {
    const built = await build();
    close = () => built.app.close();
    built.switchboard.entitled.add('u1');

    expect(await toolNames(built.registry)).toContain('entitledTool');
    expect(await toolNames(built.registry, { id: 'u2', roles: ['ADMIN'] })).not.toContain(
      'entitledTool',
    );
  });

  it('honours a decorator-declared `enabled: false`', async () => {
    const built = await build();
    close = () => built.app.close();

    expect(await toolNames(built.registry)).not.toContain('staticallyOffTool');
  });

  it('leaves a tool that declares no gates fully available', async () => {
    const built = await build();
    close = () => built.app.close();

    expect(await toolNames(built.registry)).toContain('plainTool');
  });
});

@Agent({ name: 'worker', systemPrompt: 'a worker' })
@Injectable()
class WorkerAgent {}

@Agent({
  name: 'boss',
  systemPrompt: 'a boss',
  handoff: [WorkerAgent, { agent: WorkerAgent, detached: true }],
})
@Injectable()
class BossAgent {}

describe('AiToolDiscoveryService — the delegate tool a handoff synthesizes', () => {
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
    close = undefined;
  });

  async function registerHandoffs() {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AgentModule.forRoot({
          model: new FakeModelProvider(() => ({ text: 'noop' })),
          store: new InMemoryAgentStore(),
          actorResolver: new HeaderActorResolver(),
          defaultAgent: 'boss',
        }),
      ],
      providers: [WorkerAgent, BossAgent],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    close = () => app.close();
    return app.get<ToolRegistry>(AGENT_TOOL_REGISTRY);
  }

  it('gives the awaited and the backgrounded edge to one agent separate tools', async () => {
    const registry = await registerHandoffs();
    expect(registry.spec('ask_worker')).toMatchObject({ targetAgent: 'worker' });
    expect(registry.spec('ask_worker')?.detached).toBeUndefined();
    expect(registry.spec('start_worker')).toMatchObject({ targetAgent: 'worker', detached: true });
  });

  it('carries the detached flag the edge was authored with', async () => {
    const registry = await registerHandoffs();
    expect(registry.spec('start_worker')).toMatchObject({
      kind: 'agent',
      targetAgent: 'worker',
      detached: true,
    });
  });

  it("tells the model the call hands back a receipt, not the worker's answer", async () => {
    const registry = await registerHandoffs();
    const description = registry.spec('start_worker')?.description ?? '';
    expect(description).toContain('BACKGROUND');
    expect(description).toContain('NOT an answer');
  });
});

@Agent({ name: 'helper', systemPrompt: 'a helper' })
@Injectable()
class HelperAgent {}

@Agent({
  name: 'concierge',
  systemPrompt: 'a concierge',
  handoff: [WorkerAgent, { agent: HelperAgent, roles: [PERSONAL_AGENT_ROLE] }],
})
@Injectable()
class ConciergeAgent {}

describe('AiToolDiscoveryService — an edge’s roles gate its delegate tool', () => {
  it('carries roles onto the delegate tool, so a personal agent is offered only the opened edge', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AgentModule.forRoot({
          model: new FakeModelProvider(() => ({ text: 'noop' })),
          store: new InMemoryAgentStore(),
          actorResolver: new HeaderActorResolver(),
          defaultAgent: 'concierge',
        }),
      ],
      providers: [WorkerAgent, HelperAgent, ConciergeAgent],
    }).compile();
    const app = moduleRef.createNestApplication();
    await app.init();
    try {
      const registry = app.get<ToolRegistry>(AGENT_TOOL_REGISTRY);
      const policy = app.get<RolesPolicy>(AGENT_ROLES_POLICY);
      expect(registry.spec('ask_helper')?.roles).toEqual([PERSONAL_AGENT_ROLE]);
      expect(registry.spec('ask_worker')?.roles).toBeUndefined();
      const personalAgent = { id: 'acct-1', roles: [PERSONAL_AGENT_ROLE] };
      const offered = (await registry.definitionsFor(personalAgent, policy)).map((d) => d.name);
      expect(offered).toContain('ask_helper');
      expect(offered).not.toContain('ask_worker');
    } finally {
      await app.close();
    }
  });
});
