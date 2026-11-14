import type { ModelCatalog, ModelCatalogQuery, ModelProvider } from '@dudousxd/nestjs-agent-core';
import {
  FakeModelProvider,
  type FakeScript,
  InMemoryAgentStore,
} from '@dudousxd/nestjs-agent-testing';
import { Injectable, Logger, type Type } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentModule } from './agent.module.js';
import type { AgentModuleOptions } from './agent.options.js';
import { AgentService } from './agent.service.js';
import { Agent } from './decorator/agent.decorator.js';
import { HeaderActorResolver } from './resolver/header-actor-resolver.js';

@Agent({
  name: 'writer',
  systemPrompt: 'writer',
  model: 'smart',
  personas: [
    { id: 'quick', label: 'Quick', model: 'fast' },
    { id: 'plain', label: 'Plain' },
  ],
})
@Injectable()
class WriterAgent {}

@Agent({ name: 'labelled', systemPrompt: 'labelled', model: 'claude-label-only' })
@Injectable()
class LabelledAgent {}

@Agent({ name: 'bare', systemPrompt: 'bare' })
@Injectable()
class BareAgent {}

/** `pro` only for admins; the queries are recorded. */
class RoleCatalog implements ModelCatalog {
  readonly queries: ModelCatalogQuery[] = [];

  list(query: ModelCatalogQuery) {
    this.queries.push(query);
    const admin = query.actor.roles?.includes('ADMIN') === true;
    return {
      default: 'fast',
      providers: [
        {
          id: 'models',
          label: 'Models',
          models: [
            { id: 'fast', label: 'Fast', available: true },
            { id: 'smart', label: 'Smart', available: true },
            {
              id: 'pro',
              label: 'Pro',
              available: admin,
              ...(admin ? {} : { unavailableReason: 'upgrade your plan' }),
            },
          ],
        },
      ],
    };
  }
}

let app: NestExpressApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  vi.restoreAllMocks();
});

/** A provider that records the turns it served, by name. */
function recording(name: string, served: string[], script?: FakeScript): ModelProvider {
  return new FakeModelProvider((args, turnIndex) => {
    served.push(`${name}:${args.system.split('\n')[0]}`);
    return script?.(args, turnIndex) ?? { text: `from ${name}` };
  });
}

async function boot(options: Partial<AgentModuleOptions>, agents: Type<object>[]) {
  const store = new InMemoryAgentStore();
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        store,
        actorResolver: new HeaderActorResolver(),
        defaultAgent: 'writer',
        ...options,
      }),
    ],
    providers: agents,
  }).compile();
  const testApp = moduleRef.createNestApplication<NestExpressApplication>();
  await testApp.init();
  app = testApp;
  return { server: testApp.getHttpServer(), service: moduleRef.get(AgentService), store };
}

async function send(server: unknown, body: object, role = 'USER') {
  return request(server as Parameters<typeof request>[0])
    .post('/agent/chat')
    .set('x-actor-id', role === 'ADMIN' ? 'admin' : 'u1')
    .set('x-actor-role', role)
    .send({ message: 'hi', ...body });
}

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of iterable) out += decoder.decode(chunk);
  return out;
}

describe('named models (model: { fast, smart })', () => {
  function named(served: string[], script?: FakeScript): Partial<AgentModuleOptions> {
    return {
      model: { fast: recording('fast', served, script), smart: recording('smart', served, script) },
      defaultModel: 'fast',
    };
  }

  it('runs each agent and persona on its own model, with the send and the pin winning', async () => {
    const served: string[] = [];
    const { server } = await boot(named(served), [WriterAgent, BareAgent]);

    await send(server, { agent: 'writer' });
    await send(server, { agent: 'writer', persona: 'quick' });
    await send(server, { agent: 'writer', persona: 'plain' });
    await send(server, { agent: 'writer', persona: 'quick', model: 'smart' });
    await send(server, { agent: 'bare' });
    expect(served).toEqual([
      'smart:writer',
      'fast:writer',
      'smart:writer',
      'smart:writer',
      'fast:bare',
    ]);

    // A thread pin beats the persona's model.
    const first = await send(server, { agent: 'writer', persona: 'quick' });
    const threadId = first.headers['x-agent-thread-id'] as string;
    await request(server)
      .patch(`/agent/threads/${threadId}`)
      .set('x-actor-id', 'u1')
      .send({ model: 'smart' })
      .expect(200);
    await send(server, { threadId });
    expect(served.slice(-2)).toEqual(['fast:writer', 'smart:writer']);
  });

  it('answers each agent and persona model as the picker default', async () => {
    const { server } = await boot(named([]), [WriterAgent, BareAgent]);
    const get = async (query: string) =>
      (await request(server).get(`/agent/models${query}`).set('x-actor-id', 'u1')).body;
    expect((await get('?filter[agent]=writer')).default).toBe('smart');
    expect((await get('?filter[agent]=writer&filter[persona]=quick')).default).toBe('fast');
    expect((await get('?filter[agent]=writer&filter[persona]=nope')).default).toBe('smart');
    expect((await get('?filter[agent]=bare')).default).toBe('fast');
    expect((await get('')).data[0].models.map((m: { id: string }) => m.id)).toEqual([
      'fast',
      'smart',
    ]);
  });

  it('labels usage with the resolved model when the provider reports none', async () => {
    const { service, store } = await boot(named([]), [WriterAgent]);
    const { runId } = await service.chat({ actor: { id: 'u1', roles: [] }, message: 'hi' });
    await collect(service.subscribe(runId));
    expect(store.usageRows().map((row) => row.modelId)).toEqual(['smart']);
  });

  it('runs a delegate on its own model, not the caller’s', async () => {
    @Agent({ name: 'helper', systemPrompt: 'helper', model: 'fast' })
    @Injectable()
    class HelperAgent {}

    @Agent({ name: 'boss', systemPrompt: 'boss', model: 'smart', handoff: [HelperAgent] })
    @Injectable()
    class BossAgent {}

    const served: string[] = [];
    const script: FakeScript = (args, turnIndex) =>
      args.system.startsWith('boss') && turnIndex === 0
        ? { text: 'asking', toolCall: { name: 'ask_helper', input: { task: 'help' } } }
        : { text: 'done' };
    const { service } = await boot({ ...named(served, script), defaultAgent: 'boss' }, [
      HelperAgent,
      BossAgent,
    ]);
    const { runId } = await service.chat({
      actor: { id: 'u1', roles: [] },
      message: 'go',
      model: 'smart',
    });
    await collect(service.subscribe(runId));
    expect(served).toEqual(['smart:boss', 'fast:helper', 'smart:boss']);
  });

  it('refuses defaultModel without a map, and a default that names no model', async () => {
    await expect(
      boot({ model: recording('one', []), defaultModel: 'fast' }, [BareAgent]),
    ).rejects.toThrow(/defaultModel/);
    await expect(
      boot({ model: { fast: recording('fast', []) }, defaultModel: 'smart' }, [BareAgent]),
    ).rejects.toThrow(/not one of the configured models/);
  });
});

describe('a model that names no configured model', () => {
  it('stays the accounting label, with one boot warning', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const served: string[] = [];
    const { service, store } = await boot(
      { model: recording('one', served), defaultAgent: 'labelled' },
      [LabelledAgent],
    );
    const warnings = warn.mock.calls.filter(([message]) =>
      String(message).includes('claude-label-only'),
    );
    expect(warnings).toHaveLength(1);
    expect(String(warnings[0]?.[0])).toContain('accounting label');

    const { runId } = await service.chat({ actor: { id: 'u1', roles: [] }, message: 'hi' });
    await collect(service.subscribe(runId));
    expect(served).toEqual(['one:labelled']);
    expect(store.usageRows().map((row) => row.modelId)).toEqual(['claude-label-only']);
  });

  it('warns about a persona model no configured model answers to, and uses the agent’s', async () => {
    @Agent({
      name: 'odd',
      systemPrompt: 'odd',
      model: 'smart',
      personas: [{ id: 'ghost', label: 'Ghost', model: 'missing' }],
    })
    @Injectable()
    class OddAgent {}

    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const served: string[] = [];
    const { server } = await boot(
      {
        model: { fast: recording('fast', served), smart: recording('smart', served) },
        defaultAgent: 'odd',
      },
      [OddAgent],
    );
    expect(warn.mock.calls.some(([message]) => String(message).includes('"missing"'))).toBe(true);
    await send(server, { persona: 'ghost' });
    expect(served).toEqual(['smart:odd']);
  });
});

describe('with a per-caller catalog', () => {
  @Agent({ name: 'premium', systemPrompt: 'premium', model: 'pro' })
  @Injectable()
  class PremiumAgent {}

  it('gates an agent model for the caller, naming the agent', async () => {
    const seen: Array<string | undefined> = [];
    const catalog = new RoleCatalog();
    const { server } = await boot(
      {
        model: new FakeModelProvider((args) => {
          seen.push(args.model);
          return { text: 'ok' };
        }),
        models: catalog,
        defaultAgent: 'premium',
      },
      [PremiumAgent],
    );
    const refused = await send(server, {});
    expect(refused.status).toBe(400);
    expect(refused.body).toMatchObject({ code: 'model_not_allowed' });
    expect(refused.body.message).toContain('agent "premium"');
    expect((await send(server, {}, 'ADMIN')).status).toBe(201);
    // A pick the caller may use still goes through.
    expect((await send(server, { model: 'fast' })).status).toBe(201);
    expect(seen).toEqual(['pro', 'fast']);
    expect(catalog.queries.at(-1)).toMatchObject({ agent: 'premium' });
  });

  it('lets a catalog lock win over the agent model', async () => {
    const seen: Array<string | undefined> = [];
    const { server } = await boot(
      {
        model: new FakeModelProvider((args) => {
          seen.push(args.model);
          return { text: 'ok' };
        }),
        models: {
          list: () => ({
            default: 'fast',
            locked: { model: 'fast' },
            providers: [
              { id: 'm', label: 'M', models: [{ id: 'fast', label: 'Fast', available: true }] },
            ],
          }),
        },
      },
      [WriterAgent],
    );
    expect((await send(server, {})).status).toBe(201);
    expect(seen).toEqual(['fast']);
  });

  it('refuses a delegation whose model the caller may not use, and the parent still answers', async () => {
    @Agent({ name: 'lead', systemPrompt: 'lead', handoff: [PremiumAgent] })
    @Injectable()
    class LeadAgent {}

    const results: unknown[] = [];
    const { service } = await boot(
      {
        model: new FakeModelProvider((args, turnIndex) => {
          if (turnIndex === 0)
            return { text: 'asking', toolCall: { name: 'ask_premium', input: { task: 'x' } } };
          results.push(...(args.messages.at(-1)?.toolResults ?? []).map((r) => r.output));
          return { text: 'answered anyway' };
        }),
        models: new RoleCatalog(),
        defaultAgent: 'lead',
      },
      [LeadAgent, PremiumAgent],
    );
    const { runId } = await service.chat({ actor: { id: 'u1', roles: [] }, message: 'go' });
    expect(await collect(service.subscribe(runId))).toContain('answered anyway');
    expect(JSON.stringify(results)).toContain('upgrade your plan');
  });
});
