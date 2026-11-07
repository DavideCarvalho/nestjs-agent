// Guards passed as `decorators: [UseGuards(...)]` run in Nest's ExecutionContext pipeline, which only
// fires over a real HTTP request — so these tests boot a real NestExpressApplication and drive it
// with `fetch`.
import type { AddressInfo } from 'node:net';
import { FakeModelProvider, InMemoryAgentStore } from '@dudousxd/nestjs-agent-testing';
import type { CanActivate, ExecutionContext } from '@nestjs/common';
import { ForbiddenException, Injectable, UnauthorizedException, UseGuards } from '@nestjs/common';
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

type GuardClass = new (...args: never[]) => CanActivate;

async function boot(guards?: GuardClass[]): Promise<string> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRoot({
        model: new FakeModelProvider(() => ({ text: 'ok' })),
        store: new InMemoryAgentStore(),
        actorResolver: new HeaderActorResolver(),
        defaultAgent: 'default',
        ...(guards !== undefined ? { decorators: [UseGuards(...guards)] } : {}),
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

async function bootAsync(guards?: GuardClass[]): Promise<string> {
  const moduleRef = await Test.createTestingModule({
    imports: [
      AgentModule.forRootAsync({
        useFactory: () => ({
          model: new FakeModelProvider(() => ({ text: 'ok' })),
          store: new InMemoryAgentStore(),
          actorResolver: new HeaderActorResolver(),
          defaultAgent: 'default',
        }),
        ...(guards !== undefined ? { decorators: [UseGuards(...guards)] } : {}),
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
});

describe('decorators: [UseGuards(...)] — forRoot', () => {
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
      ['/agent/quota'],
      ['/agent/agents'],
    ];
    for (const [path, init] of routes) {
      const res = await fetch(`${baseUrl}${path}`, init);
      expect(res.status).toBe(403);
    }
  });
});

describe('decorators: [UseGuards(...)] — forRootAsync (static field)', () => {
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

describe('decorators never stick to the shared controller classes', () => {
  it('leaves the classes themselves without the guards a registration passed', () => {
    AgentModule.forRoot({
      model: new FakeModelProvider(() => ({ text: 'ok' })),
      store: new InMemoryAgentStore(),
      actorResolver: new HeaderActorResolver(),
      decorators: [UseGuards(TokenGuard, DenyGuard)],
    });
    for (const controller of [
      ChatController,
      ThreadsController,
      ToolCallController,
      QuotaController,
      AgentsController,
      AttachmentsController,
    ]) {
      expect(Reflect.getMetadata(GUARDS_METADATA, controller) ?? []).toEqual([]);
    }
  });
});
