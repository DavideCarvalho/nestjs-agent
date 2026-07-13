// `AgentModuleOptions.surface` decides which controllers this process mounts. Default/omitted
// ('both') must be byte-for-byte today's behavior; 'engine' mounts none; 'http' mounts every
// controller, same as 'both'. See `./durable/agent-durable-surface.spec.ts` for the durable-side
// half of the split (workflow/step-handler registration) and
// `./durable/agent-surface-cross-role.spec.ts` for a full turn running across both roles.
import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import { Injectable } from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentModule } from './agent.module.js';
import type { AgentModuleOptions, AgentSurface } from './agent.options.js';
import { Agent } from './decorator/agent.decorator.js';
import { HeaderActorResolver } from './resolver/header-actor-resolver.js';

@Agent({ name: 'default', systemPrompt: 'surface test agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

let app: INestApplication | undefined;

async function boot(surface?: AgentSurface): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model: new FakeModelProvider(() => ({ text: 'ok' })),
        store: new InMemoryAgentStore(),
        actorResolver: new HeaderActorResolver(),
        defaultAgent: 'default',
        ...(surface !== undefined ? { surface } : {}),
      }),
    ],
    providers: [DefaultAgent],
  }).compile();
  app = moduleRef.createNestApplication();
  await app.init();
  return app;
}

async function bootAsync(surface?: AgentSurface): Promise<INestApplication> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRootAsync({
        useFactory: (): AgentModuleOptions => ({
          model: new FakeModelProvider(() => ({ text: 'ok' })),
          store: new InMemoryAgentStore(),
          actorResolver: new HeaderActorResolver(),
          defaultAgent: 'default',
        }),
        ...(surface !== undefined ? { surface } : {}),
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
});

/** Every route the base five controllers mount, with a request that would succeed if reachable. */
const AGENT_ROUTES: [string, string, Record<string, string>][] = [
  ['post', '/agent/chat', { 'x-actor-id': 'u1', 'x-actor-role': 'ADMIN' }],
  ['get', '/agent/threads', { 'x-actor-id': 'u1' }],
  ['post', '/agent/tool-call/approve', { 'x-actor-id': 'u1' }],
  ['get', '/agent/quota/today', { 'x-actor-id': 'u1' }],
  ['get', '/agent/agents', { 'x-actor-id': 'u1' }],
];

/** A body that satisfies each POST route's own DTO well enough to avoid an unrelated 500. */
function bodyFor(path: string): Record<string, unknown> {
  if (path === '/agent/chat') return { message: 'hi' };
  if (path === '/agent/tool-call/approve') return { toolCallId: 'does-not-exist' };
  return {};
}

async function requestRoute(
  server: Parameters<typeof request>[0],
  method: string,
  path: string,
  headers: Record<string, string>,
) {
  const req =
    method === 'post'
      ? request(server).post(path).send(bodyFor(path)).set('content-type', 'application/json')
      : request(server).get(path);
  for (const [name, value] of Object.entries(headers)) {
    req.set(name, value);
  }
  return req;
}

/**
 * `'engine'` mounting NO controllers at all produces Nest's own routing 404 ("Cannot POST /x"),
 * distinguishable from a MOUNTED controller's own domain 404 (e.g. approve on a toolCallId that
 * doesn't exist) — both are HTTP status 404, only the platform fallback carries this message shape.
 */
function isRouteMissing(res: request.Response): boolean {
  const body: unknown = res.body;
  return (
    res.status === 404 &&
    typeof body === 'object' &&
    body !== null &&
    'error' in body &&
    body.error === 'Not Found' &&
    'message' in body &&
    typeof body.message === 'string' &&
    body.message.startsWith('Cannot ')
  );
}

describe('surface option — forRoot', () => {
  it('omitted defaults to "both" — every route reachable, exactly like today', async () => {
    const testApp = await boot();
    for (const [method, path, headers] of AGENT_ROUTES) {
      const res = await requestRoute(testApp.getHttpServer(), method, path, headers);
      expect(isRouteMissing(res)).toBe(false);
    }
  });

  it('"both" is byte-for-byte identical to omitted', async () => {
    const testApp = await boot('both');
    for (const [method, path, headers] of AGENT_ROUTES) {
      const res = await requestRoute(testApp.getHttpServer(), method, path, headers);
      expect(isRouteMissing(res)).toBe(false);
    }
  });

  it('"http" mounts every controller, fully functional', async () => {
    const testApp = await boot('http');
    const chat = await request(testApp.getHttpServer())
      .post('/agent/chat')
      .set('content-type', 'application/json')
      .set('x-actor-id', 'u1')
      .set('x-actor-role', 'ADMIN')
      .send({ message: 'hi' });
    expect(chat.status).toBe(201);
    const threads = await requestRoute(testApp.getHttpServer(), 'get', '/agent/threads', {
      'x-actor-id': 'u1',
    });
    expect(threads.status).toBe(200);
  });

  it('"engine" mounts NO controllers — every agent route 404s', async () => {
    const testApp = await boot('engine');
    for (const [method, path, headers] of AGENT_ROUTES) {
      const res = await requestRoute(testApp.getHttpServer(), method, path, headers);
      expect(res.status).toBe(404);
      expect(isRouteMissing(res)).toBe(true);
    }
  });
});

describe('surface option — forRootAsync (static field)', () => {
  it('omitted defaults to "both"', async () => {
    const testApp = await bootAsync();
    const res = await requestRoute(testApp.getHttpServer(), 'get', '/agent/threads', {
      'x-actor-id': 'u1',
    });
    expect(res.status).toBe(200);
  });

  it('"engine" mounts NO controllers', async () => {
    const testApp = await bootAsync('engine');
    for (const [method, path, headers] of AGENT_ROUTES) {
      const res = await requestRoute(testApp.getHttpServer(), method, path, headers);
      expect(res.status).toBe(404);
      expect(isRouteMissing(res)).toBe(true);
    }
  });

  it('"http" keeps every controller functional', async () => {
    const testApp = await bootAsync('http');
    const res = await requestRoute(testApp.getHttpServer(), 'get', '/agent/threads', {
      'x-actor-id': 'u1',
    });
    expect(res.status).toBe(200);
  });
});
