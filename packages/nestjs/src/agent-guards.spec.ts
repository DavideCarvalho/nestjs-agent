// Guards run in Nest's ExecutionContext pipeline, which only fires over a real HTTP request — so
// these tests boot a real NestExpressApplication and drive it with `fetch`, mirroring the style
// proven in @dudousxd/nestjs-media's media-guards.spec.ts (same GUARDS_METADATA mechanism).
import type { AddressInfo } from 'node:net';
import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { ForbiddenException, Injectable, UnauthorizedException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentModule } from './agent.module.js';
import { AgentsController } from './controller/agents.controller.js';
import { AttachmentsController } from './controller/attachments.controller.js';
import { ChatController } from './controller/chat.controller.js';
import { QuotaController } from './controller/quota.controller.js';
import { ThreadsController } from './controller/threads.controller.js';
import { ToolCallController } from './controller/tool-call.controller.js';
import { Agent } from './decorator/agent.decorator.js';
import { HeaderActorResolver } from './resolver/header-actor-resolver.js';

const TOKEN = 'let-me-in';

/** Rejects unless `x-test-token` matches; otherwise indistinguishable from a real auth guard. */
@Injectable()
class TokenGuard implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const request_ = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined> }>();
    if (request_.headers['x-test-token'] !== TOKEN) {
      throw new UnauthorizedException('missing or bad token');
    }
    return true;
  }
}

/** Always denies — proves a guard actually gates the route at all. */
@Injectable()
class DenyGuard implements CanActivate {
  canActivate(): boolean {
    throw new ForbiddenException('nope');
  }
}

@Agent({ name: 'default', systemPrompt: 'test agent', model: 'fake-1' })
@Injectable()
class DefaultAgent {}

let app: NestExpressApplication | undefined;

async function boot(guards?: Parameters<typeof AgentModule.forRoot>[0]['guards']): Promise<string> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model: new FakeModelProvider(() => ({ text: 'ok' })),
        store: new InMemoryAgentStore(),
        actorResolver: new HeaderActorResolver(),
        defaultAgent: 'default',
        ...(guards !== undefined ? { guards } : {}),
      }),
    ],
    providers: [DefaultAgent],
  }).compile();
  const testApp = moduleRef.createNestApplication<NestExpressApplication>();
  app = testApp;
  await testApp.listen(0);
  const address = testApp.getHttpServer().address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

async function bootAsync(
  guards?: Parameters<typeof AgentModule.forRootAsync>[0]['guards'],
): Promise<string> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRootAsync({
        useFactory: () => ({
          model: new FakeModelProvider(() => ({ text: 'ok' })),
          store: new InMemoryAgentStore(),
          actorResolver: new HeaderActorResolver(),
          defaultAgent: 'default',
        }),
        ...(guards !== undefined ? { guards } : {}),
      }),
    ],
    providers: [DefaultAgent],
  }).compile();
  const testApp = moduleRef.createNestApplication<NestExpressApplication>();
  app = testApp;
  await testApp.listen(0);
  const address = testApp.getHttpServer().address() as AddressInfo;
  return `http://127.0.0.1:${address.port}`;
}

afterEach(async () => {
  await app?.close();
  app = undefined;
  // Reset the shared controller classes' metadata so an earlier test's guards don't leak.
  AgentModule.forRoot({
    model: new FakeModelProvider(() => ({ text: 'ok' })),
    store: new InMemoryAgentStore(),
    actorResolver: new HeaderActorResolver(),
  });
});

describe('guards option — forRoot', () => {
  it('with no guards, the surface stays open (current default behavior)', async () => {
    const baseUrl = await boot();
    const res = await fetch(`${baseUrl}/agent/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-actor-id': 'u1', 'x-actor-role': 'ADMIN' },
      body: JSON.stringify({ message: 'hi' }),
    });
    expect(res.status).toBe(201);
  });

  it('rejects a request that fails the guard', async () => {
    const baseUrl = await boot([TokenGuard]);
    const res = await fetch(`${baseUrl}/agent/threads`, { headers: { 'x-actor-id': 'u1' } });
    expect(res.status).toBe(401);
  });

  it('allows a request that passes the guard', async () => {
    const baseUrl = await boot([TokenGuard]);
    const res = await fetch(`${baseUrl}/agent/threads`, {
      headers: { 'x-actor-id': 'u1', 'x-test-token': TOKEN },
    });
    expect(res.status).toBe(200);
  });

  it('a guard that always denies blocks the route entirely', async () => {
    const baseUrl = await boot([DenyGuard]);
    const res = await fetch(`${baseUrl}/agent/agents`);
    expect(res.status).toBe(403);
  });

  it('gates every mounted controller — chat, threads, tool-call, quota, agents', async () => {
    const baseUrl = await boot([DenyGuard]);
    const routes: [string, RequestInit?][] = [
      [
        '/agent/chat',
        { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } },
      ],
      ['/agent/threads'],
      [
        '/agent/tool-call/approve',
        { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } },
      ],
      ['/agent/quota/today'],
      ['/agent/agents'],
    ];
    for (const [path, init] of routes) {
      const res = await fetch(`${baseUrl}${path}`, init);
      expect(res.status).toBe(403);
    }
  });
});

describe('guards option — forRootAsync (static field)', () => {
  it('applies guards even though options are resolved async', async () => {
    const baseUrl = await bootAsync([TokenGuard]);
    const denied = await fetch(`${baseUrl}/agent/threads`, { headers: { 'x-actor-id': 'u1' } });
    expect(denied.status).toBe(401);

    const allowed = await fetch(`${baseUrl}/agent/threads`, {
      headers: { 'x-actor-id': 'u1', 'x-test-token': TOKEN },
    });
    expect(allowed.status).toBe(200);
  });

  it('no guards on forRootAsync stays open, same as forRoot', async () => {
    const baseUrl = await bootAsync();
    const res = await fetch(`${baseUrl}/agent/threads`, { headers: { 'x-actor-id': 'u1' } });
    expect(res.status).toBe(200);
  });
});

describe('inlined GUARDS_METADATA literal', () => {
  // agent.module.ts inlines '__guards__' instead of deep-importing '@nestjs/common/constants'
  // (whose extensionless ESM emit breaks strict resolvers in consumers). This pins the literal to
  // the real upstream constant so a Nest rename fails here instead of silently stamping a dead key.
  it('matches @nestjs/common/constants', () => {
    expect(GUARDS_METADATA).toBe('__guards__');
  });
});

describe('guards metadata replaces rather than accumulates across registrations', () => {
  it('a later forRoot() call with fewer/no guards overrides an earlier one on the shared controller classes', () => {
    const baseOptions = {
      model: new FakeModelProvider(() => ({ text: 'ok' })),
      store: new InMemoryAgentStore(),
      actorResolver: new HeaderActorResolver(),
    };
    AgentModule.forRoot({ ...baseOptions, guards: [TokenGuard, DenyGuard] });
    expect(Reflect.getMetadata(GUARDS_METADATA, ChatController)).toEqual([TokenGuard, DenyGuard]);

    AgentModule.forRoot({ ...baseOptions, guards: [TokenGuard] });
    expect(Reflect.getMetadata(GUARDS_METADATA, ChatController)).toEqual([TokenGuard]);

    AgentModule.forRoot(baseOptions);
    expect(Reflect.getMetadata(GUARDS_METADATA, ChatController)).toEqual([]);
    expect(Reflect.getMetadata(GUARDS_METADATA, ThreadsController)).toEqual([]);
    expect(Reflect.getMetadata(GUARDS_METADATA, ToolCallController)).toEqual([]);
    expect(Reflect.getMetadata(GUARDS_METADATA, QuotaController)).toEqual([]);
    expect(Reflect.getMetadata(GUARDS_METADATA, AgentsController)).toEqual([]);
    expect(Reflect.getMetadata(GUARDS_METADATA, AttachmentsController)).toEqual([]);
  });
});
