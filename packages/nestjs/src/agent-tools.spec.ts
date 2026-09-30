// `GET /agent/tools` as a consumer meets it: `@AiTool({ presentation })` providers discovered at
// boot, answered with what THIS actor can reach through the chosen agent — the same gates the model
// is offered tools through, so a chat never narrates a tool the model cannot call.
import type { ToolCatalogEntry, ToolPresentation } from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { Injectable } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentModule } from './agent.module.js';
import { Agent } from './decorator/agent.decorator.js';
import { AiTool } from './decorator/ai-tool.decorator.js';
import { HeaderActorResolver } from './resolver/header-actor-resolver.js';

const queryPresentation: ToolPresentation = {
  label: 'Database query',
  running: 'Querying {table}',
  done: 'Queried {table}',
  icon: 'database',
  result: { kind: 'metrics', fields: [{ path: 'count', label: 'Rows' }] },
};

const purgePresentation: ToolPresentation = {
  label: 'Cache purge',
  running: 'Purging {key}',
  done: 'Purged {key}',
  tone: 'destructive',
  confirm: { title: 'Purge {key}?', verb: 'Purge' },
};

@AiTool({
  name: 'query',
  kind: 'read',
  description: 'q',
  input: z.object({ table: z.string() }),
  roles: ['USER', 'ADMIN'],
  presentation: queryPresentation,
})
@Injectable()
class QueryTool {
  async execute() {
    return { count: 1 };
  }
}

@AiTool({
  name: 'purge',
  kind: 'action',
  description: 'p',
  input: z.object({ key: z.string() }),
  roles: ['ADMIN'],
  presentation: purgePresentation,
})
@Injectable()
class PurgeTool {
  async execute() {
    return {};
  }
}

@AiTool({ name: 'plain', kind: 'read', description: 'no presentation', input: z.object({}) })
@Injectable()
class PlainTool {
  async execute() {
    return {};
  }
}

@Agent({ name: 'default', systemPrompt: 'tools test agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

@Agent({ name: 'reader', systemPrompt: 'reads only', model: 'fake-1', tools: ['query'] })
@Injectable()
class ReaderAgent {}

let app: INestApplication | undefined;

async function boot(): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model: new FakeModelProvider(() => ({ text: 'ok' })),
        store: new InMemoryAgentStore(),
        actorResolver: new HeaderActorResolver(),
        defaultAgent: 'default',
      }),
    ],
    providers: [QueryTool, PurgeTool, PlainTool, DefaultAgent, ReaderAgent],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /agent/tools', () => {
  it("lists the actor's tools with their presentation, and plain tools without one", async () => {
    const res = await request((await boot()).getHttpServer())
      .get('/agent/tools')
      .set('x-actor-id', 'a1')
      .set('x-actor-role', 'ADMIN');
    expect(res.status).toBe(200);
    const byName = new Map((res.body as ToolCatalogEntry[]).map((entry) => [entry.name, entry]));
    expect(byName.get('query')).toEqual({
      name: 'query',
      kind: 'read',
      presentation: queryPresentation,
    });
    expect(byName.get('purge')).toEqual({
      name: 'purge',
      kind: 'action',
      presentation: purgePresentation,
    });
    expect(byName.get('plain')).toEqual({ name: 'plain', kind: 'read' });
  });

  it('leaves out a tool the actor may not use', async () => {
    const res = await request((await boot()).getHttpServer())
      .get('/agent/tools')
      .set('x-actor-id', 'u1')
      .set('x-actor-role', 'USER');
    // `purge` names ADMIN; `plain` names no roles, which by default restricts nobody.
    expect((res.body as ToolCatalogEntry[]).map((entry) => entry.name)).toEqual(['query', 'plain']);
  });

  it("narrows to the named agent's allow-list", async () => {
    const res = await request((await boot()).getHttpServer())
      .get('/agent/tools?agent=reader')
      .set('x-actor-id', 'a1')
      .set('x-actor-role', 'ADMIN');
    expect((res.body as ToolCatalogEntry[]).map((entry) => entry.name)).toEqual(['query']);
  });

  it('answers 404 for an agent that does not exist rather than listing every tool', async () => {
    const res = await request((await boot()).getHttpServer())
      .get('/agent/tools?agent=ghost')
      .set('x-actor-id', 'a1')
      .set('x-actor-role', 'ADMIN');
    expect(res.status).toBe(404);
  });

  it('refuses a caller with no identity', async () => {
    const res = await request((await boot()).getHttpServer()).get('/agent/tools');
    expect(res.status).toBe(401);
  });
});
