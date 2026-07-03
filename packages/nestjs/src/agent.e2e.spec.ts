import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
} from '@dudousxd/nestjs-agent-testing';
import type { AgentDefinition, RolesPolicy } from '@dudousxd/nestjs-agent-core';
import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import type { NestExpressApplication } from '@nestjs/platform-express';
import request from 'supertest';
import { z } from 'zod';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentModule } from './agent.module.js';
import { AgentService } from './agent.service.js';
import { AiTool } from './decorator/ai-tool.decorator.js';
import { HeaderActorResolver } from './resolver/header-actor-resolver.js';

@AiTool({ name: 'getWeather', kind: 'read', description: 'weather', input: z.object({ city: z.string() }) })
@Injectable()
class GetWeatherTool {
  async execute(input: { city: string }) {
    return { tempC: 21, city: input.city };
  }
}

@AiTool({ name: 'purgeCache', kind: 'action', description: 'purge', input: z.object({ key: z.string() }) })
@Injectable()
class PurgeCacheTool {
  async execute(input: { key: string }) {
    return { purged: input.key };
  }
}

@AiTool({
  name: 'abilityTool',
  kind: 'read',
  description: 'ability-gated',
  input: z.object({}),
  ability: 'cache.purge',
})
@Injectable()
class AbilityTool {
  async execute() {
    return { ok: true };
  }
}

interface BuildOptions {
  rolesPolicy?: RolesPolicy;
  features?: AgentDefinition[];
  path?: string;
}

async function buildApp(script: FakeScript, options: BuildOptions = {}) {
  const store = new InMemoryAgentStore();
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model: new FakeModelProvider(script),
        store,
        actorResolver: new HeaderActorResolver(),
        defaultAgent: { modelId: 'fake-1', systemPrompt: 'test agent' },
        ...(options.path !== undefined ? { path: options.path } : {}),
        ...(options.rolesPolicy !== undefined ? { rolesPolicy: options.rolesPolicy } : {}),
      }),
      ...(options.features !== undefined ? [AgentModule.forFeature(options.features)] : []),
    ],
    providers: [GetWeatherTool, PurgeCacheTool, AbilityTool],
  }).compile();
  const app = moduleRef.createNestApplication<NestExpressApplication>();
  await app.init();
  return { app, store, service: app.get(AgentService) };
}

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of iterable) {
    out += decoder.decode(chunk);
  }
  return out;
}

describe('AgentModule (inline)', () => {
  let app: NestExpressApplication | undefined;
  afterEach(async () => {
    await app?.close();
    app = undefined;
  });

  it('streams a no-tool turn over SSE', async () => {
    const built = await buildApp(() => ({ text: 'hello over http' }));
    app = built.app;
    const res = await request(app.getHttpServer())
      .post('/agent/chat')
      .set('x-actor-id', 'u1')
      .set('x-actor-role', 'ADMIN')
      .send({ message: 'hi' });
    expect(res.status).toBe(201);
    expect(res.text).toContain('hello over http');
    expect(res.text).toContain('event: done');
  });

  it('refuses a request whose actor cannot be resolved (no x-actor-id)', async () => {
    const built = await buildApp(() => ({ text: 'never reached' }));
    app = built.app;
    const res = await request(app.getHttpServer()).post('/agent/chat').send({ message: 'hi' });
    expect(res.status).toBe(500);
    expect(res.text).not.toContain('never reached');
    // nothing was persisted for a caller the resolver refused to identify
    expect(built.store.toolCallRows()).toHaveLength(0);
  });

  it('mounts the controllers under a configured route path', async () => {
    const built = await buildApp(() => ({ text: 'hi from /ai' }), { path: 'ai' });
    app = built.app;

    const mounted = await request(app.getHttpServer())
      .post('/ai/chat')
      .set('x-actor-id', 'u1')
      .set('x-actor-role', 'ADMIN')
      .send({ message: 'hi' });
    expect(mounted.status).toBe(201);
    expect(mounted.text).toContain('hi from /ai');

    // the default '/agent' prefix no longer exists
    const defaultPath = await request(app.getHttpServer())
      .post('/agent/chat')
      .set('x-actor-id', 'u1')
      .send({ message: 'hi' });
    expect(defaultPath.status).toBe(404);
  });

  it('auto-executes a read tool then answers', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'checking', toolCall: { name: 'getWeather', input: { city: 'Recife' } } }
        : { text: 'it is 21C' };
    const built = await buildApp(script);
    app = built.app;
    const { runId } = await built.service.chat({ actor: { id: 'u1', roles: ['ADMIN'] }, message: 'weather?' });
    const streamed = await collect(built.service.subscribe(runId));
    expect(streamed).toContain('it is 21C');
    expect(built.store.toolCallRows()[0]).toMatchObject({ toolName: 'getWeather', status: 'executed' });
  });

  it('suspends an action tool until approved, then executes', async () => {
    const script: FakeScript = (_args, turnIndex) =>
      turnIndex === 0
        ? { text: 'about to purge', toolCall: { name: 'purgeCache', input: { key: 'cfg' } } }
        : { text: 'purged ok' };
    const built = await buildApp(script);
    app = built.app;
    const { runId } = await built.service.chat({ actor: { id: 'u1', roles: ['ADMIN'] }, message: 'purge it' });

    const collected = collect(built.service.subscribe(runId));
    // give the loop a tick to reach the approval gate, then approve the (deterministic) tool id
    await new Promise((resolve) => setTimeout(resolve, 20));
    await built.service.approve(runId, 'call-0-purgeCache');

    const streamed = await collected;
    expect(streamed).toContain('purged ok');
    expect(built.store.toolCallRows()[0]).toMatchObject({ toolName: 'purgeCache', status: 'executed' });
  });

  it('orchestrator delegates to a sub-agent via a synthesized agent tool', async () => {
    const script: FakeScript = (args, turnIndex) => {
      const lastUser =
        [...args.messages].reverse().find((m) => m.role === 'user' && m.content)?.content?.toLowerCase() ??
        '';
      if (turnIndex === 0) {
        if (lastUser.includes('delegate')) {
          return { text: 'delegating', toolCall: { name: 'ask_sub', input: { task: 'weather please' } } };
        }
        if (lastUser.includes('weather')) {
          return { text: 'checking', toolCall: { name: 'getWeather', input: { city: 'Recife' } } };
        }
        return { text: 'no tool' };
      }
      const results = (args.messages.at(-1)?.toolResults ?? []).map((result) => result.output);
      return { text: `done: ${JSON.stringify(results)}` };
    };
    const built = await buildApp(script, {
      features: [
        { name: 'orch', systemPrompt: 'orchestrator', delegatesTo: ['sub'] },
        { name: 'sub', systemPrompt: 'sub', tools: ['getWeather'] },
      ],
    });
    app = built.app;
    const { runId } = await built.service.chat({
      actor: { id: 'u1', roles: ['ADMIN'] },
      message: 'delegate this',
      agentName: 'orch',
    });
    const streamed = await collect(built.service.subscribe(runId));

    expect(streamed).toContain('done:');
    const rows = built.store.toolCallRows();
    // the sub-agent actually ran getWeather (on its own thread; the store is shared)
    expect(rows.some((row) => row.toolName === 'getWeather' && row.status === 'executed')).toBe(true);
    // the orchestrator recorded the delegation as an `agent`-kind tool call
    expect(rows.some((row) => row.toolName === 'ask_sub')).toBe(true);
  });

  it("passes a tool's @AiTool ability through to the RolesPolicy", async () => {
    const seen: { name: string; ability?: string }[] = [];
    const recordingPolicy: RolesPolicy = {
      can: (_actor, tool) => {
        seen.push({ name: tool.name, ...(tool.ability !== undefined ? { ability: tool.ability } : {}) });
        return true;
      },
    };
    const built = await buildApp(() => ({ text: 'noop' }), { rolesPolicy: recordingPolicy });
    app = built.app;
    const { runId } = await built.service.chat({ actor: { id: 'u1', roles: ['ADMIN'] }, message: 'hi' });
    await collect(built.service.subscribe(runId));

    expect(seen.find((tool) => tool.name === 'abilityTool')?.ability).toBe('cache.purge');
  });
});
