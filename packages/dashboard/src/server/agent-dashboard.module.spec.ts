import 'reflect-metadata';
import { AGENT_ACTOR_RESOLVER, AGENT_GOVERNANCE_QUERIES } from '@dudousxd/nestjs-agent-core';
import {
  type CanActivate,
  type ExecutionContext,
  Global,
  Injectable,
  Logger,
  Module,
  UseGuards,
} from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AgentApiController } from './agent-api.controller.js';
import { AgentDashboardModule } from './agent-dashboard.module.js';
import { AgentUiController } from './agent-ui.controller.js';
import { CONSOLE_AUTHORIZE_MISSING_WARNING, authorizeByToken } from './console-authorize.js';

@Injectable()
class DenyAll implements CanActivate {
  canActivate(): boolean {
    return false;
  }
}

/** Plays the app's authentication guard: `x-user` → `request.user`. */
@Injectable()
class HeaderAuth implements CanActivate {
  canActivate(context: ExecutionContext): boolean {
    const req = context
      .switchToHttp()
      .getRequest<{ headers: Record<string, string | undefined>; user?: unknown }>();
    const id = req.headers['x-user'];
    req.user = id === undefined ? null : { id, admin: id === 'admin' };
    return true;
  }
}

/** What a real host's AgentModule and store module bind globally. */
@Global()
@Module({
  providers: [
    { provide: AGENT_GOVERNANCE_QUERIES, useValue: {} },
    { provide: AGENT_ACTOR_RESOLVER, useValue: { resolve: () => ({ id: 'console' }) } },
  ],
  exports: [AGENT_GOVERNANCE_QUERIES, AGENT_ACTOR_RESOLVER],
})
class HostStoreModule {}

const previousEnv = process.env.NODE_ENV;
let close: (() => Promise<void>) | undefined;

afterEach(async () => {
  process.env.NODE_ENV = previousEnv;
  vi.restoreAllMocks();
  await close?.();
  close = undefined;
});

async function boot(dashboard: ReturnType<typeof AgentDashboardModule.forRoot>) {
  @Module({ imports: [HostStoreModule, dashboard] })
  class HostRootModule {}
  const app = await NestFactory.create(HostRootModule, { logger: false, abortOnError: false });
  await app.init();
  close = () => app.close();
  return app.getHttpServer();
}

/** Past the console's access check: the console's own handling answers (not 401/403). */
function expectPastAccess(status: number): void {
  expect([401, 403]).not.toContain(status);
}

const HTML = { Accept: 'text/html,application/xhtml+xml' };

describe('AgentDashboardModule — default when `authorize` is omitted', () => {
  it('boots in production (no boot refusal), and denies every request with 403', async () => {
    process.env.NODE_ENV = 'production';
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    expect(() => AgentDashboardModule.forRoot()).not.toThrow();
    const server = await boot(AgentDashboardModule.forRoot());
    const api = await request(server).get('/ai-gateway/api/spend').expect(403);
    expect(api.body).toEqual({ error: 'forbidden' });
    await request(server).get('/ai-gateway/api/stream').expect(403);
    await request(server).post('/ai-gateway/api/pricing').send({}).expect(403);
    const page = await request(server).get('/ai-gateway').set(HTML).expect(403);
    expect(page.headers['content-type']).toMatch(/text\/html/);
    expect(page.text).toMatch(/Access denied/);
  });

  it('`decorators` alone do not count as protection in production', async () => {
    process.env.NODE_ENV = 'production';
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const server = await boot(
      AgentDashboardModule.forRoot({ decorators: [UseGuards(HeaderAuth)] }),
    );
    await request(server).get('/ai-gateway/api/spend').set({ 'x-user': 'admin' }).expect(403);
  });

  it('is open outside production', async () => {
    process.env.NODE_ENV = 'development';
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const server = await boot(AgentDashboardModule.forRoot());
    expectPastAccess((await request(server).get('/ai-gateway/api/spend')).status);
  });

  it('logs the warning exactly once at boot', async () => {
    process.env.NODE_ENV = 'production';
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const server = await boot(AgentDashboardModule.forRoot());
    await request(server).get('/ai-gateway/api/spend');
    await request(server).get('/ai-gateway');
    const calls = warn.mock.calls.filter(
      ([message]) => message === CONSOLE_AUTHORIZE_MISSING_WARNING,
    );
    expect(calls).toHaveLength(1);
  });

  it('logs no warning once `authorize` is set', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    await boot(AgentDashboardModule.forRoot({ authorize: () => true }));
    expect(warn.mock.calls.map(([m]) => m)).not.toContain(CONSOLE_AUTHORIZE_MISSING_WARNING);
  });
});

describe('AgentDashboardModule — `authorize`', () => {
  it('allows in production when `authorize` allows', async () => {
    process.env.NODE_ENV = 'production';
    const server = await boot(AgentDashboardModule.forRoot({ authorize: () => true }));
    expectPastAccess((await request(server).get('/ai-gateway/api/spend')).status);
  });

  it('runs after the app’s decorators, so `request.user` is set', async () => {
    const server = await boot(
      AgentDashboardModule.forRoot({
        decorators: [UseGuards(HeaderAuth)],
        authorize: (ctx) =>
          ctx.switchToHttp().getRequest<{ user?: { admin: boolean } | null }>().user?.admin ===
          true,
      }),
    );
    expectPastAccess(
      (await request(server).get('/ai-gateway/api/spend').set({ 'x-user': 'admin' })).status,
    );
    const denied = await request(server)
      .get('/ai-gateway/api/spend')
      .set({ 'x-user': 'bob' })
      .expect(403);
    expect(denied.body).toEqual({ error: 'forbidden' });
  });

  it('forbidden: 403 JSON for the API, the denied page for a page navigation', async () => {
    const server = await boot(AgentDashboardModule.forRoot({ authorize: () => false }));
    expect((await request(server).get('/ai-gateway/api/spend').expect(403)).body).toEqual({
      error: 'forbidden',
    });
    const page = await request(server).get('/ai-gateway').set(HTML).expect(403);
    expect(page.text).toMatch(/Access denied/);
    // An asset, or the page fetched without Accept: text/html, is answered as JSON.
    expect((await request(server).get('/ai-gateway').expect(403)).body).toEqual({
      error: 'forbidden',
    });
  });

  it('unauthenticated: 401 JSON', async () => {
    const server = await boot(
      AgentDashboardModule.forRoot({
        authorize: () => ({ allowed: false, reason: 'unauthenticated' }) as const,
      }),
    );
    expect((await request(server).get('/ai-gateway/api/spend').expect(401)).body).toEqual({
      error: 'unauthenticated',
    });
    await request(server).get('/ai-gateway').set(HTML).expect(401);
  });

  it('redirectTo: 302 for a page navigation, 401 JSON with redirectTo for the API', async () => {
    const server = await boot(
      AgentDashboardModule.forRoot({ authorize: () => ({ redirectTo: '/login' }) }),
    );
    const page = await request(server).get('/ai-gateway').set(HTML).expect(302);
    expect(page.headers.location).toBe('/login');
    expect((await request(server).get('/ai-gateway/api/spend').expect(401)).body).toEqual({
      error: 'unauthenticated',
      redirectTo: '/login',
    });
  });

  it('a throwing `authorize` is a 403', async () => {
    vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const server = await boot(
      AgentDashboardModule.forRoot({
        authorize: () => {
          throw new Error('boom');
        },
      }),
    );
    await request(server).get('/ai-gateway/api/spend').expect(403);
  });

  it('authorizeByToken over HTTP', async () => {
    const server = await boot(
      AgentDashboardModule.forRoot({ authorize: authorizeByToken({ token: 'tok' }) }),
    );
    expectPastAccess(
      (await request(server).get('/ai-gateway/api/spend').set('Authorization', 'Bearer tok'))
        .status,
    );
    await request(server).get('/ai-gateway/api/spend?token=tok').expect(401);
  });

  it('a gate name without AuthzModule fails the boot', async () => {
    await expect(
      boot(AgentDashboardModule.forRoot({ authorize: 'console.agent' })),
    ).rejects.toThrow(/needs @dudousxd\/nestjs-authz's AuthzModule/);
  });

  it('applies decorators to the mounted routes, and never to the shared controller classes', async () => {
    const server = await boot(
      AgentDashboardModule.forRoot({ decorators: [UseGuards(DenyAll)], authorize: () => true }),
    );
    await request(server).get('/ai-gateway/api/spend').expect(403);
    expect(Reflect.getMetadata(GUARDS_METADATA, AgentApiController) ?? []).toEqual([]);
    expect(Reflect.getMetadata(GUARDS_METADATA, AgentUiController) ?? []).toEqual([]);
  });
});
