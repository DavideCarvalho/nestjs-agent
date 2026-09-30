import type { ModelCatalog, ModelCatalogQuery } from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { Injectable } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentModule } from './agent.module.js';
import { AgentService } from './agent.service.js';
import { Agent } from './decorator/agent.decorator.js';
import { HeaderActorResolver } from './resolver/header-actor-resolver.js';

@Agent({ name: 'default', systemPrompt: 'models test agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

/** `pro` only for admins; `legacy` listed but switched off; the query is recorded. */
class RoleCatalog implements ModelCatalog {
  readonly queries: ModelCatalogQuery[] = [];

  list(query: ModelCatalogQuery) {
    this.queries.push(query);
    const admin = query.actor.roles?.includes('ADMIN') === true;
    return {
      default: 'fast',
      providers: [
        {
          id: 'openai',
          label: 'OpenAI',
          models: [
            { id: 'fast', label: 'Fast', badges: ['fast'], available: true },
            {
              id: 'pro',
              label: 'Pro',
              badges: ['reasoning'],
              available: admin,
              ...(admin ? {} : { unavailableReason: 'upgrade your plan' }),
            },
          ],
        },
        {
          id: 'old',
          label: 'Old',
          models: [{ id: 'legacy', label: 'Legacy', available: false }],
        },
      ],
    };
  }
}

/** An agent that always runs on `pro`: the picker is locked, every other model unavailable. */
class LockedCatalog implements ModelCatalog {
  list() {
    return {
      default: 'pro',
      locked: { model: 'pro', reason: 'This assistant always uses Pro' },
      providers: [
        {
          id: 'openai',
          label: 'OpenAI',
          models: [
            {
              id: 'fast',
              label: 'Fast',
              available: false,
              unavailableReason: 'This assistant always uses Pro',
            },
            { id: 'pro', label: 'Pro', available: true },
          ],
        },
      ],
    };
  }
}

let app: NestExpressApplication | undefined;

async function boot(models?: ModelCatalog) {
  const seen: Array<string | undefined> = [];
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model: new FakeModelProvider((args) => {
          seen.push(args.model);
          return { text: 'ok' };
        }),
        store: new InMemoryAgentStore(),
        actorResolver: new HeaderActorResolver(),
        defaultAgent: 'default',
        ...(models !== undefined ? { models } : {}),
      }),
    ],
    providers: [DefaultAgent],
  }).compile();
  const testApp = moduleRef.createNestApplication<NestExpressApplication>();
  await testApp.init();
  app = testApp;
  return { server: testApp.getHttpServer(), service: moduleRef.get(AgentService), seen };
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

/** POST a turn and wait for it to finish; answers the status. */
async function send(server: unknown, actor: string, body: object, role = 'USER') {
  const res = await request(server as Parameters<typeof request>[0])
    .post('/agent/chat')
    .set('x-actor-id', actor)
    .set('x-actor-role', role)
    .send({ message: 'hi', ...body });
  return res;
}

function threadIdOf(res: { headers: Record<string, string> }): string {
  return res.headers['x-agent-thread-id'] as string;
}

describe('GET /agent/models', () => {
  it('answers an empty catalog when none is bound', async () => {
    const { server } = await boot();
    const res = await request(server).get('/agent/models').set('x-actor-id', 'u1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ providers: [], default: null });
  });

  it('answers the catalog for the caller and the agent it names', async () => {
    const catalog = new RoleCatalog();
    const { server } = await boot(catalog);
    const res = await request(server)
      .get('/agent/models?agent=default')
      .set('x-actor-id', 'u1')
      .set('x-actor-role', 'USER');
    expect(res.status).toBe(200);
    expect(res.body.default).toBe('fast');
    expect(res.body.providers[0].models[1]).toMatchObject({
      id: 'pro',
      available: false,
      unavailableReason: 'upgrade your plan',
    });
    expect(catalog.queries[0]).toMatchObject({ actor: { id: 'u1' }, agent: 'default' });
  });
});

describe('the model a turn runs on', () => {
  it('runs a send on the model it names, and on the provider default otherwise', async () => {
    const { server, seen } = await boot(new RoleCatalog());
    expect((await send(server, 'u1', { model: 'fast' })).status).toBe(201);
    expect((await send(server, 'u1', {})).status).toBe(201);
    expect(seen[0]).toBe('fast');
    expect(seen.at(-1)).toBeUndefined();
  });

  it('refuses a model the catalog does not offer, or offers switched off, or with no catalog', async () => {
    const withCatalog = await boot(new RoleCatalog());
    const unknown = await send(withCatalog.server, 'u1', { model: 'nope' });
    expect(unknown.status).toBe(400);
    const locked = await send(withCatalog.server, 'u1', { model: 'pro' });
    expect(locked.status).toBe(400);
    expect(locked.body.message).toContain('upgrade your plan');
    expect((await send(withCatalog.server, 'admin', { model: 'pro' }, 'ADMIN')).status).toBe(201);
    expect(withCatalog.seen).toEqual(['pro']);
    await app?.close();

    const without = await boot();
    expect((await send(without.server, 'u1', { model: 'fast' })).status).toBe(400);
    expect(without.seen).toEqual([]);
  });

  it('pins a model on the thread, lets a send override it, and unpins on null', async () => {
    const { server, service, seen } = await boot(new RoleCatalog());
    const first = await send(server, 'admin', {}, 'ADMIN');
    const threadId = threadIdOf(first);
    const patch = (body: object) =>
      request(server)
        .patch(`/agent/threads/${threadId}`)
        .set('x-actor-id', 'admin')
        .set('x-actor-role', 'ADMIN')
        .send(body);

    expect((await patch({ model: 'fast' })).status).toBe(200);
    expect((await service.getThread({ id: 'admin' }, threadId))?.model).toBe('fast');
    await send(server, 'admin', { threadId }, 'ADMIN');
    await send(server, 'admin', { threadId, model: 'pro' }, 'ADMIN');
    expect(seen.slice(1)).toEqual(['fast', 'pro']);

    // The send's own model was that turn's only: the pin is untouched.
    expect((await service.getThread({ id: 'admin' }, threadId))?.model).toBe('fast');
    await send(server, 'admin', { threadId }, 'ADMIN');
    expect(seen.at(-1)).toBe('fast');

    expect((await patch({ model: 'legacy' })).status).toBe(400);
    expect((await patch({ model: null })).status).toBe(200);
    expect((await service.getThread({ id: 'admin' }, threadId))?.model).toBeNull();
    await send(server, 'admin', { threadId }, 'ADMIN');
    expect(seen.at(-1)).toBeUndefined();
  });
});

describe('a send names a model for that turn only', () => {
  it('never pins it — not on a new thread, not on an existing one', async () => {
    const { server, service, seen } = await boot(new RoleCatalog());
    const first = await send(server, 'u1', { model: 'fast' });
    const threadId = threadIdOf(first);
    expect((await service.getThread({ id: 'u1' }, threadId))?.model ?? null).toBeNull();

    await send(server, 'u1', { threadId, model: 'fast' });
    expect((await service.getThread({ id: 'u1' }, threadId))?.model ?? null).toBeNull();
    await send(server, 'u1', { threadId });
    expect(seen).toEqual(['fast', 'fast', undefined]);
  });
});

describe('a catalog locked to one model', () => {
  it('reports the lock, runs every turn on it, and refuses another model', async () => {
    const { server, seen } = await boot(new LockedCatalog());
    const models = await request(server).get('/agent/models').set('x-actor-id', 'u1');
    expect(models.body.locked).toEqual({ model: 'pro', reason: 'This assistant always uses Pro' });

    expect((await send(server, 'u1', {})).status).toBe(201);
    expect((await send(server, 'u1', { model: 'pro' })).status).toBe(201);
    const refused = await send(server, 'u1', { model: 'fast' });
    expect(refused.status).toBe(400);
    expect(refused.body.message).toContain('always uses Pro');
    expect(seen).toEqual(['pro', 'pro']);
  });
});
