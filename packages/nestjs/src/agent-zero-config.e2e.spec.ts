import {
  AGENT_STORE,
  InMemoryAgentStore,
  type ModelCatalog,
  type ModelProvider,
  type ModelTurnArgs,
  type ToolCatalogEntry,
} from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider } from '@dudousxd/nestjs-agent-testing';
import { Global, Injectable, Module } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentModule } from './agent.module.js';
import type { AgentModuleOptions } from './agent.options.js';
import { AgentService } from './agent.service.js';
import { AiTool } from './decorator/ai-tool.decorator.js';
import { requestUserActorResolver } from './resolver/request-user-actor-resolver.js';

@AiTool({ description: 'Weather for a city', input: z.object({ city: z.string() }) })
@Injectable()
class GetWeatherTool {
  async execute(input: { city: string }) {
    return { city: input.city, tempC: 21 };
  }
}

let app: NestExpressApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
});

async function boot(
  options: Partial<AgentModuleOptions> = {},
  extra: { imports?: unknown[]; providers?: unknown[] } = {},
) {
  const systems: string[] = [];
  const moduleRef = await Test.createTestingModule({
    imports: [
      ...((extra.imports ?? []) as never[]),
      AgentModule.forRoot({
        model: new FakeModelProvider((args) => {
          systems.push(args.system);
          return { text: 'hello' };
        }),
        ...options,
      }),
    ],
    providers: [GetWeatherTool, ...((extra.providers ?? []) as never[])],
  }).compile();
  const testApp = moduleRef.createNestApplication<NestExpressApplication>();
  await testApp.init();
  app = testApp;
  return { server: testApp.getHttpServer(), moduleRef, systems };
}

function cookieOf(res: { headers: Record<string, unknown> }): string {
  const set = res.headers['set-cookie'] as string[] | undefined;
  const cookie = set?.find((value) => value.startsWith('agent_anon='));
  if (cookie === undefined) throw new Error('no agent_anon cookie was set');
  return cookie.split(';')[0] as string;
}

describe('AgentModule with nothing but a model', () => {
  it('chats with no login, no store and no roles — each browser its own anonymous actor', async () => {
    const { server } = await boot();

    const first = await request(server).post('/agent/chat').send({ message: 'hi' });
    expect(first.status).toBe(201);
    const alice = cookieOf(first);
    expect(first.headers['set-cookie']?.[0]).toMatch(/HttpOnly/);
    expect(first.headers['set-cookie']?.[0]).toMatch(/SameSite=Lax/);

    const mine = await request(server).get('/agent/threads').set('Cookie', alice);
    expect(mine.status).toBe(200);
    expect(mine.body).toHaveLength(1);
    // The same browser keeps its identity: no new cookie on the way back.
    expect(mine.headers['set-cookie']).toBeUndefined();

    // Another browser (no cookie) sees none of it — and gets an identity of its own.
    const theirs = await request(server).get('/agent/threads');
    expect(theirs.body).toEqual([]);
    const bob = cookieOf(theirs);
    expect(bob).not.toBe(alice);
    const threadId = first.headers['x-agent-thread-id'] as string;
    const peek = await request(server).get(`/agent/threads/${threadId}`).set('Cookie', bob);
    expect([403, 404]).toContain(peek.status);
  });

  it('offers every tool to an anonymous actor, named and kinded by default', async () => {
    const { server } = await boot();
    const res = await request(server).get('/agent/tools');
    expect(res.status).toBe(200);
    expect(res.body as ToolCatalogEntry[]).toEqual([
      expect.objectContaining({ name: 'getWeather', kind: 'read' }),
    ]);
  });

  it('runs the default agent on the module-level systemPrompt (string or function)', async () => {
    const plain = await boot({ systemPrompt: 'You are Flippy.' });
    await request(plain.server).post('/agent/chat').send({ message: 'hi' });
    expect(plain.systems[0]).toContain('You are Flippy.');
    await app?.close();

    const built = await boot({ systemPrompt: ({ actor }) => `Talking to ${actor.id}` });
    await request(built.server).post('/agent/chat').send({ message: 'hi' });
    expect(built.systems[0]).toMatch(/Talking to anon:/);
  });

  it('requestUserActorResolver() requires login: 401 without req.user', async () => {
    const { server } = await boot({ actorResolver: requestUserActorResolver() });
    const res = await request(server).get('/agent/threads');
    expect(res.status).toBe(401);
  });

  it('finds a store another module binds instead of shadowing it with the in-memory one', async () => {
    const external = new InMemoryAgentStore();
    @Global()
    @Module({ providers: [{ provide: AGENT_STORE, useValue: external }], exports: [AGENT_STORE] })
    class HostStoreModule {}

    const { server, moduleRef } = await boot({}, { imports: [HostStoreModule] });
    const res = await request(server).post('/agent/chat').send({ message: 'hi' });
    const threadId = res.headers['x-agent-thread-id'] as string;
    expect(await external.getThread(threadId)).toBeDefined();
    expect(moduleRef.get(AgentService)).toBeDefined();
  });

  it('lists the catalog the model provider carries when `models` is omitted', async () => {
    const seen: Array<string | undefined> = [];
    const catalog: ModelCatalog = {
      list: () => ({
        default: 'fast',
        providers: [
          {
            id: 'openai',
            label: 'OpenAI',
            models: [
              { id: 'fast', label: 'Fast', available: true },
              { id: 'smart', label: 'Smart', available: true },
            ],
          },
        ],
      }),
    };
    const fake = new FakeModelProvider((args: ModelTurnArgs) => {
      seen.push(args.model);
      return { text: 'ok' };
    });
    const model: ModelProvider & { catalog: ModelCatalog } = {
      runTurn: (args) => fake.runTurn(args),
      catalog,
    };
    const { server } = await boot({ model });
    const listed = await request(server).get('/agent/models');
    expect(listed.body.default).toBe('fast');
    const sent = await request(server).post('/agent/chat').send({ message: 'hi', model: 'smart' });
    expect(sent.status).toBe(201);
    expect(seen).toEqual(['smart']);
  });
});
