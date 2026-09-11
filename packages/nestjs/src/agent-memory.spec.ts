// The memory surface as a consumer meets it: a host provider wired at the module, `GET
// /agent/memories` showing a person everything the assistant believes about them, and `DELETE
// /agent/memories/:id` letting them take one back — the deletion half being the reason `forget` is
// a required method on the provider rather than an optional one.
import {
  AGENT_DEPS_FACTORY,
  GLOBAL_SCOPE,
  type MemoryDigestEntry,
  type MemoryProvider,
  type MemoryRecord,
} from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { Injectable } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentDepsFactory } from './agent-deps.factory.js';
import { AgentModule } from './agent.module.js';
import type { AgentMemoryOptions } from './agent.options.js';
import { Agent } from './decorator/agent.decorator.js';
import { HeaderActorResolver } from './resolver/header-actor-resolver.js';

@Agent({ name: 'default', systemPrompt: 'memory test agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

function fact(key: string, scope: string, text: string): MemoryRecord {
  return {
    id: `${scope}/${key}`,
    key,
    text,
    scope,
    origin: { author: 'agent', threadId: 't0', runId: 'r0', actorRef: 'u1' },
    updatedAt: '2026-09-01T00:00:00.000Z',
  };
}

let app: INestApplication | undefined;
let rows: MemoryRecord[] = [];

function hostProvider(): MemoryProvider {
  return {
    list: ({ scopes }) => rows.filter((row) => scopes.includes(row.scope)),
    forget: ({ id }) => {
      const index = rows.findIndex((row) => row.id === id);
      if (index === -1) return false;
      rows.splice(index, 1);
      return true;
    },
  };
}

async function boot(memory?: AgentMemoryOptions): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model: new FakeModelProvider(() => ({ text: 'ok' })),
        store: new InMemoryAgentStore(),
        actorResolver: new HeaderActorResolver(),
        defaultAgent: 'default',
        ...(memory !== undefined ? { memory } : {}),
      }),
    ],
    providers: [DefaultAgent],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  rows = [];
});

describe('GET /agent/memories', () => {
  it('answers with an empty list where the host configured no memory', async () => {
    const res = await request((await boot()).getHttpServer())
      .get('/agent/memories')
      .set('x-actor-id', 'u1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual([]);
  });

  it('shows a person their own and their org’s memories, with the beaten value carried', async () => {
    rows = [
      fact('fiscal-year', GLOBAL_SCOPE, 'starts in October'),
      fact('fiscal-year', 'actor:u1', 'they use the calendar year'),
    ];
    const res = await request((await boot({ provider: hostProvider() })).getHttpServer())
      .get('/agent/memories')
      .set('x-actor-id', 'u1');
    const entries = res.body as MemoryDigestEntry[];
    expect(entries).toHaveLength(1);
    expect(entries[0]?.text).toBe('they use the calendar year');
    expect(entries[0]?.overrides).toEqual([
      { scope: GLOBAL_SCOPE, text: 'starts in October', author: 'agent' },
    ]);
    // The origin travels: "says who, and out of what conversation" is the question a person asks
    // first, and the one thing that distinguishes this from a retrieved document.
    expect(entries[0]?.origin).toEqual({
      author: 'agent',
      threadId: 't0',
      runId: 'r0',
      actorRef: 'u1',
    });
  });

  it('shows everything, including what the prompt ceiling left out', async () => {
    // The ceiling is a budget on what a TURN carries. Applying it to the read-back would mean a
    // person could not see — and so could not delete — a belief the assistant is one write away
    // from acting on again.
    rows = [fact('a', GLOBAL_SCOPE, 'one'), fact('b', GLOBAL_SCOPE, 'two')];
    const res = await request(
      (await boot({ provider: hostProvider(), maxMemories: 1 })).getHttpServer(),
    )
      .get('/agent/memories')
      .set('x-actor-id', 'u1');
    expect((res.body as MemoryDigestEntry[]).map((entry) => entry.key)).toEqual(['a', 'b']);
  });

  it('never ranks, however large the host’s index — a person is shown every belief, not a turn’s', async () => {
    // Recall is a budget on ONE TURN's prompt. A read-back that ran it would show a person the slice
    // some question happened to need, and hide the rest of what is held about them behind having
    // asked the right thing.
    rows = [fact('a', GLOBAL_SCOPE, 'one'), fact('b', GLOBAL_SCOPE, 'two')];
    const indexed: MemoryProvider = {
      ...hostProvider(),
      search: () => {
        throw new Error('the read-back must never search');
      },
    };
    const res = await request((await boot({ provider: indexed, maxMemories: 1 })).getHttpServer())
      .get('/agent/memories')
      .set('x-actor-id', 'u1');
    expect(res.status).toBe(200);
    expect((res.body as MemoryDigestEntry[]).map((entry) => entry.key)).toEqual(['a', 'b']);
  });

  it('never shows one actor another actor’s memories', async () => {
    rows = [fact('secret', 'actor:u9', 'not yours'), fact('mine', 'actor:u1', 'yours')];
    const res = await request((await boot({ provider: hostProvider() })).getHttpServer())
      .get('/agent/memories')
      .set('x-actor-id', 'u1');
    expect((res.body as MemoryDigestEntry[]).map((entry) => entry.key)).toEqual(['mine']);
  });
});

describe('DELETE /agent/memories/:id', () => {
  it('lets a person delete what the assistant concluded about them', async () => {
    rows = [fact('units', 'actor:u1', 'nautical miles')];
    const res = await request((await boot({ provider: hostProvider() })).getHttpServer())
      .delete('/agent/memories/actor%3Au1%2Funits')
      .set('x-actor-id', 'u1');
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ forgotten: true });
    expect(rows).toEqual([]);
  });

  it('refuses to delete a memory held above the actor’s own scope', async () => {
    rows = [fact('units', GLOBAL_SCOPE, 'nautical miles')];
    const res = await request((await boot({ provider: hostProvider() })).getHttpServer())
      .delete('/agent/memories/global%2Funits')
      .set('x-actor-id', 'u1');
    expect(res.status).toBe(403);
    expect(res.body.message).toContain('administrative action');
    expect(rows).toHaveLength(1);
  });

  it('refuses an id the actor cannot see, without saying whether it exists', async () => {
    rows = [fact('secret', 'actor:u9', 'not yours')];
    const res = await request((await boot({ provider: hostProvider() })).getHttpServer())
      .delete('/agent/memories/actor%3Au9%2Fsecret')
      .set('x-actor-id', 'u1');
    expect(res.status).toBe(404);
    expect(rows).toHaveLength(1);
  });
});

describe('the read-back and the turn read one resolution', () => {
  it('hands the loop the very config the endpoint answered from', async () => {
    const application = await boot({ provider: hostProvider() });
    const factory = application.get<AgentDepsFactory>(AGENT_DEPS_FACTORY);
    const config = factory.memoryConfig();
    expect(config).toBeDefined();
    expect(factory.forAgent('default').memory).toBe(config);
  });

  it('leaves the loop without memory at all when the host configured none', async () => {
    const factory = (await boot()).get<AgentDepsFactory>(AGENT_DEPS_FACTORY);
    expect(factory.memoryConfig()).toBeUndefined();
    expect(factory.forAgent('default').memory).toBeUndefined();
  });
});
