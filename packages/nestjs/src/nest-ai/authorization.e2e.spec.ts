import type { ToolCatalogEntry } from '@dudousxd/nestjs-agent-core';
import { staticCanArgs } from '@dudousxd/nestjs-agent-core';
import { FakeModelProvider } from '@dudousxd/nestjs-agent-testing';
import { AgentFunction, AiExecutionContext, AiModule } from '@nestjs/ai';
import { FakeModel } from '@nestjs/ai/testing';
import { AuthorizationModule, Can, Policy } from '@nestjs/authorization';
import { Controller, Injectable } from '@nestjs/common';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { z } from 'zod';
import { AgentModule } from '../agent.module.js';
import { AgentService } from '../agent.service.js';
import { ThreadsController } from '../controller/threads.controller.js';
import { AiTool } from '../decorator/ai-tool.decorator.js';
import { HeaderActorResolver } from '../resolver/header-actor-resolver.js';

const ran: string[] = [];

interface User {
  id: string;
  roles?: string[];
}

@Policy()
class CachePolicy {
  purge(user: User | null) {
    return user?.roles?.includes('OPS') === true;
  }
}

@Policy()
class RolePolicy {
  has(user: User | null, role: string) {
    return user?.roles?.includes(role) === true;
  }
}

@Policy()
class CityPolicy {
  visit(user: User | null, city: string) {
    return user !== null && city !== 'Atlantis';
  }
}

@AiTool({ description: 'Purge the cache', input: z.object({}) })
@Can(CachePolicy, 'purge')
@Injectable()
class PurgeCacheTool {
  async execute() {
    return { purged: true };
  }
}

/** No @Can(): governed by the agent's roles alone. */
@AiTool({ description: 'Weather for a city', input: z.object({ city: z.string() }) })
@Injectable()
class GetWeatherTool {
  async execute(input: { city: string }) {
    ran.push(`weather:${input.city}`);
    return { tempC: 21 };
  }
}

@AiTool({ description: 'Ban a user', input: z.object({ id: z.string() }) })
@Can(RolePolicy, 'has', staticCanArgs('ADMIN'))
@Injectable()
class BanUserTool {
  async execute(input: { id: string }) {
    return { banned: input.id };
  }
}

@Injectable()
class TravelFunctions {
  @AgentFunction({
    name: 'visit',
    description: 'Visit a city',
    inputSchema: z.object({ city: z.string() }),
  })
  // What it decides reads the call: the guard checks it, on the call.
  @Can(CityPolicy, 'visit', (ctx) => [
    AiExecutionContext.create(ctx).getInput<{ city: string }>().city,
  ])
  visit({ city }: { city: string }) {
    ran.push(city);
    return { visited: city };
  }
}

let app: NestExpressApplication | undefined;

afterEach(async () => {
  await app?.close();
  app = undefined;
  ran.length = 0;
});

async function collect(iterable: AsyncIterable<Uint8Array>): Promise<string> {
  const decoder = new TextDecoder();
  let out = '';
  for await (const chunk of iterable) out += decoder.decode(chunk);
  return out;
}

async function boot(model = new FakeModel([])) {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AiModule.forRoot({ models: { default: model } }),
      AuthorizationModule.forRoot({
        globalGuard: true,
        policies: [CachePolicy, RolePolicy, CityPolicy],
      }),
      AgentModule.forRoot({ actorResolver: new HeaderActorResolver() }),
    ],
    providers: [PurgeCacheTool, BanUserTool, GetWeatherTool, TravelFunctions],
  }).compile();
  const testApp = moduleRef.createNestApplication<NestExpressApplication>();
  await testApp.init();
  app = testApp;
  return testApp;
}

const names = (res: { body: { data: unknown } }) =>
  (res.body.data as ToolCatalogEntry[]).map((tool) => tool.name);

describe("@nestjs/authorization's @Can() on agent tools", () => {
  it('offers a tool only to an actor its abilities allow, static arguments included', async () => {
    const testApp = await boot();
    const server = testApp.getHttpServer();

    const user = await request(server).get('/agent/tools').set({ 'x-actor-id': 'u1' });
    expect(names(user)).not.toContain('purgeCache');
    expect(names(user)).not.toContain('banUser');
    // Its @Can() reads the call: offered, and checked by the guard when called.
    expect(names(user)).toContain('visit');

    const ops = await request(server)
      .get('/agent/tools')
      .set({ 'x-actor-id': 'o1', 'x-actor-role': 'OPS' });
    expect(names(ops)).toContain('purgeCache');
    expect(names(ops)).not.toContain('banUser');

    const admin = await request(server)
      .get('/agent/tools')
      .set({ 'x-actor-id': 'a1', 'x-actor-role': 'ADMIN' });
    expect(names(admin)).toContain('banUser');
  });

  it("lets the method's guard refuse a call its @Can() arguments decide against", async () => {
    const model = new FakeModel([
      { toolCalls: [{ name: 'visit', input: { city: 'Atlantis' } }] },
      (call) => `Result: ${JSON.stringify(call.toolResults[0]?.output)}`,
      { toolCalls: [{ name: 'visit', input: { city: 'Recife' } }] },
      'Visited.',
    ]);
    const testApp = await boot(model);
    const agent = testApp.get(AgentService);
    const actor = { id: 'u1' };

    const refused = await agent.chat({ actor, message: 'go to Atlantis' });
    expect(await collect(agent.subscribe(refused.runId))).toMatch(/Forbidden|not allowed/i);
    expect(ran).toEqual([]);

    const allowed = await agent.chat({ actor, message: 'go to Recife' });
    expect(await collect(agent.subscribe(allowed.runId))).toContain('Visited.');
    expect(ran).toEqual(['Recife']);
  });

  it("runs an @AiTool with no @Can() under the global guard: the agent's roles govern it", async () => {
    const model = new FakeModel([
      { toolCalls: [{ name: 'getWeather', input: { city: 'Recife' } }] },
      'Done.',
    ]);
    const testApp = await boot(model);
    const agent = testApp.get(AgentService);
    const { runId } = await agent.chat({ actor: { id: 'u1' }, message: 'weather?' });
    expect(await collect(agent.subscribe(runId))).toContain('Done.');
    expect(ran).toEqual(['weather:Recife']);
  });

  it('refuses the boot for an @AiTool whose @Can() reads the call when no guard would check it', async () => {
    @AiTool({ description: 'Visit', input: z.object({ city: z.string() }) })
    @Can(CityPolicy, 'visit', () => ['Recife'])
    @Injectable()
    class VisitTool {
      async execute() {
        return {};
      }
    }
    const moduleRef = await Test.createTestingModule({
      imports: [
        AuthorizationModule.forRoot({ policies: [CityPolicy] }),
        AgentModule.forRoot({
          model: new FakeModelProvider(() => ({ text: 'hi' })),
          actorResolver: new HeaderActorResolver(),
        }),
      ],
      providers: [VisitTool],
    }).compile();
    const testApp = moduleRef.createNestApplication<NestExpressApplication>();
    await expect(testApp.init()).rejects.toThrow(/only its guard can check/);
    await testApp.close().catch(() => undefined);
  });
});

describe("AgentModule({ decorators }) — who reaches the agent's routes, with @nestjs/authorization", () => {
  /** The official guard's user, from the same headers the agent's actor resolver reads. */
  const getUser = (context: import('@nestjs/common').ExecutionContext) => {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>();
    const id = req.headers['x-actor-id'];
    if (id === undefined) return null;
    const role = req.headers['x-actor-role'];
    return { id, roles: role !== undefined ? [role] : [] };
  };

  async function bootWith(decorators: ClassDecorator[] | undefined) {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AuthorizationModule.forRoot({ getUser, policies: [RolePolicy] }),
        AgentModule.forRoot({
          model: new FakeModelProvider(() => ({ text: 'hi' })),
          actorResolver: new HeaderActorResolver(),
          ...(decorators !== undefined ? { decorators } : {}),
        }),
      ],
    }).compile();
    const testApp = moduleRef.createNestApplication<NestExpressApplication>();
    await testApp.init();
    app = testApp;
    return testApp.getHttpServer();
  }

  it('applies a @Can() passed as decorators to every agent route', async () => {
    const server = await bootWith([Can(RolePolicy, 'has', staticCanArgs('ADMIN'))]);
    await request(server).get('/agent/tools').set({ 'x-actor-id': 'u1' }).expect(403);
    await request(server).get('/agent/tools').expect(401);
    await request(server)
      .get('/agent/tools')
      .set({ 'x-actor-id': 'a1', 'x-actor-role': 'ADMIN' })
      .expect(200);
  });

  it('leaves the routes open to the official guard without decorators, and nothing leaks from a previous registration', async () => {
    await bootWith([Can(RolePolicy, 'has', staticCanArgs('ADMIN'))]);
    await app?.close();
    const server = await bootWith(undefined);
    // Deny-by-default would refuse an undecorated route: the agent's are marked open, and the
    // ADMIN requirement of the registration before did not stick to the shared controller class.
    await request(server).get('/agent/tools').set({ 'x-actor-id': 'u1' }).expect(200);
  });
});

describe('AgentModule({ routes: false }) — the routes on controllers of the app’s own', () => {
  @Controller('ops/agent/threads')
  @Can(RolePolicy, 'has', staticCanArgs('ADMIN'))
  class OwnThreadsController extends ThreadsController {}

  async function bootOwn() {
    const moduleRef = await Test.createTestingModule({
      imports: [
        AuthorizationModule.forRoot({
          policies: [RolePolicy],
          getUser: (context: import('@nestjs/common').ExecutionContext) => {
            const req = context
              .switchToHttp()
              .getRequest<{ headers: Record<string, string | undefined> }>();
            const id = req.headers['x-actor-id'];
            return id === undefined ? null : { id, roles: [req.headers['x-actor-role'] ?? ''] };
          },
        }),
        AgentModule.forRoot({
          model: new FakeModelProvider(() => ({ text: 'hi' })),
          actorResolver: new HeaderActorResolver(),
          routes: false,
        }),
      ],
      controllers: [OwnThreadsController],
    }).compile();
    const testApp = moduleRef.createNestApplication<NestExpressApplication>();
    await testApp.init();
    app = testApp;
    return testApp.getHttpServer();
  }

  it('mounts none of its own, and the app’s controller serves them under its own @Can()', async () => {
    const server = await bootOwn();
    await request(server).get('/agent/threads').set({ 'x-actor-id': 'a1' }).expect(404);
    await request(server).get('/ops/agent/threads').expect(401);
    await request(server).get('/ops/agent/threads').set({ 'x-actor-id': 'u1' }).expect(403);
    const admin = await request(server)
      .get('/ops/agent/threads')
      .set({ 'x-actor-id': 'a1', 'x-actor-role': 'ADMIN' })
      .expect(200);
    expect(admin.body).toEqual({ data: [] });
  });
});
