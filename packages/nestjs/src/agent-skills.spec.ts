// The skills surface as a consumer meets it: `@Skill` providers discovered at boot, a host provider
// merged alongside them, and `GET /agent/skills` answering with what THIS actor can reach — the same
// resolution the turn itself runs, so a `/`-autocomplete cannot offer a skill the model has never
// heard of.
import {
  AGENT_DEPS_FACTORY,
  GLOBAL_SCOPE,
  type SkillCatalogEntry,
  type SkillContext,
  type SkillProvider,
  offerSkills,
} from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { Injectable } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import type { AgentDepsFactory } from './agent-deps.factory.js';
import { AgentModule } from './agent.module.js';
import type { AgentSkillsOptions } from './agent.options.js';
import { Agent } from './decorator/agent.decorator.js';
import { Skill, type SkillBody } from './decorator/skill.decorator.js';
import { HeaderActorResolver } from './resolver/header-actor-resolver.js';

@Agent({ name: 'default', systemPrompt: 'skills test agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

@Skill({
  name: 'normalize-unit',
  description: 'Normalise a unit designation to DPAS form.',
  body: 'GLOBAL-BODY',
})
@Injectable()
class NormalizeUnitSkill {}

@Skill({ name: 'work-order', description: 'Open a work order.', scope: 'tenant:base-7' })
@Injectable()
class WorkOrderSkill implements SkillBody {
  body(ctx: SkillContext): string {
    return `Open a work order for ${ctx.actor.id}.`;
  }
}

@Skill({ name: 'nothing', description: 'declares no body at all' })
@Injectable()
class BodilessSkill {}

let app: INestApplication | undefined;

async function boot(skills?: AgentSkillsOptions): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model: new FakeModelProvider(() => ({ text: 'ok' })),
        store: new InMemoryAgentStore(),
        actorResolver: new HeaderActorResolver(),
        defaultAgent: 'default',
        ...(skills !== undefined ? { skills } : {}),
      }),
    ],
    providers: [DefaultAgent, NormalizeUnitSkill, WorkOrderSkill, BodilessSkill],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

async function listSkills(
  application: INestApplication,
  headers: Record<string, string>,
): Promise<SkillCatalogEntry[]> {
  const req = request(application.getHttpServer()).get('/agent/skills');
  for (const [name, value] of Object.entries(headers)) {
    req.set(name, value);
  }
  const res = await req;
  expect(res.status).toBe(200);
  return res.body as SkillCatalogEntry[];
}

afterEach(async () => {
  await app?.close();
  app = undefined;
});

describe('GET /agent/skills', () => {
  it('answers with an empty list when the host configured no skills, decorated classes or not', async () => {
    expect(await listSkills(await boot(), { 'x-actor-id': 'u1' })).toEqual([]);
  });

  it('lists a discovered @Skill with its name, description and scope', async () => {
    const entries = await listSkills(await boot({}), { 'x-actor-id': 'u1' });
    expect(entries).toEqual([
      {
        name: 'normalize-unit',
        description: 'Normalise a unit designation to DPAS form.',
        scope: 'global',
      },
    ]);
  });

  it('offers a tenant skill only to an actor of that tenant', async () => {
    const application = await boot({});
    const inTenant = await listSkills(application, {
      'x-actor-id': 'u1',
      'x-tenant-ref': 'base-7',
    });
    expect(inTenant.map((entry) => `${entry.scope}/${entry.name}`)).toEqual([
      'tenant:base-7/work-order',
      'global/normalize-unit',
    ]);
    const outside = await listSkills(application, { 'x-actor-id': 'u2', 'x-tenant-ref': 'base-9' });
    expect(outside.map((entry) => entry.name)).toEqual(['normalize-unit']);
  });

  it('reports the scope a skill overrode, so a client can say whose setting won', async () => {
    const hostProvider: SkillProvider = {
      list: ({ scopes }) =>
        scopes.includes('tenant:base-7')
          ? [
              {
                name: 'normalize-unit',
                description: 'Base 7 strips the suffix first.',
                scope: 'tenant:base-7',
              },
            ]
          : [],
      load: () => 'TENANT-BODY',
    };
    const entries = await listSkills(await boot({ provider: hostProvider }), {
      'x-actor-id': 'u1',
      'x-tenant-ref': 'base-7',
    });
    expect(entries).toContainEqual({
      name: 'normalize-unit',
      description: 'Base 7 strips the suffix first.',
      scope: 'tenant:base-7',
      shadows: ['global'],
    });
  });

  it('drops a @Skill that declares no body, rather than offering one that answers nothing', async () => {
    const entries = await listSkills(await boot({}), { 'x-actor-id': 'u1' });
    expect(entries.map((entry) => entry.name)).not.toContain('nothing');
  });
});

describe('the listing endpoint and the turn read one resolution', () => {
  it('hands the loop the very config the endpoint answered from', async () => {
    const application = await boot({});
    const factory = application.get<AgentDepsFactory>(AGENT_DEPS_FACTORY);
    const config = factory.skillsConfig();
    expect(config).toBeDefined();
    expect(factory.forAgent('default').skills).toBe(config);

    const listed = await listSkills(application, { 'x-actor-id': 'u1', 'x-tenant-ref': 'base-7' });
    const offered = await offerSkills(
      // biome-ignore lint/style/noNonNullAssertion: asserted defined above.
      config!,
      { actor: { id: 'u1', tenantRef: 'base-7' }, threadId: '' },
    );
    expect(offered.entries).toEqual(listed);
  });

  it('leaves the loop without skills at all when the host configured none', async () => {
    const factory = (await boot()).get<AgentDepsFactory>(AGENT_DEPS_FACTORY);
    expect(factory.skillsConfig()).toBeUndefined();
    expect(factory.forAgent('default').skills).toBeUndefined();
  });
});

describe('a @Skill body', () => {
  it('is built per turn from the class method, with the turn’s context', async () => {
    const application = await boot({});
    const config = application.get<AgentDepsFactory>(AGENT_DEPS_FACTORY).skillsConfig();
    const ctx: SkillContext = { actor: { id: 'u1', tenantRef: 'base-7' }, threadId: 't1' };
    // biome-ignore lint/style/noNonNullAssertion: skills are configured in this boot.
    expect(await config!.provider.load({ name: 'work-order', scope: 'tenant:base-7', ctx })).toBe(
      'Open a work order for u1.',
    );
  });

  it('is the flat string for a class that declares one', async () => {
    const application = await boot({});
    const config = application.get<AgentDepsFactory>(AGENT_DEPS_FACTORY).skillsConfig();
    const ctx: SkillContext = { actor: { id: 'u1' }, threadId: 't1' };
    // biome-ignore lint/style/noNonNullAssertion: skills are configured in this boot.
    expect(await config!.provider.load({ name: 'normalize-unit', scope: GLOBAL_SCOPE, ctx })).toBe(
      'GLOBAL-BODY',
    );
  });
});
