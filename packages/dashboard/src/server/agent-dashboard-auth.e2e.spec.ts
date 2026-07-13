import { AGENT_GOVERNANCE_QUERIES } from '@dudousxd/nestjs-agent-core';
import {
  type CanActivate,
  type ExecutionContext,
  Global,
  Injectable,
  Module,
} from '@nestjs/common';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import request from 'supertest';
import { afterEach, describe, expect, it } from 'vitest';
import { AgentDashboardModule } from './agent-dashboard.module.js';
import { SESSION_COOKIE_NAME } from './auth/session-cookie-io.js';

/** Bare governance read-model — only `recentRuns` is exercised by these specs (`GET /runs`). */
@Global()
@Module({
  providers: [{ provide: AGENT_GOVERNANCE_QUERIES, useValue: { recentRuns: async () => [] } }],
  exports: [AGENT_GOVERNANCE_QUERIES],
})
class FakeGovernanceStoreModule {}

/** A guard proving the HOST'S OWN gate still runs alongside `dashboardAuth` (AND semantics). */
@Injectable()
class DenyEveryoneGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return false;
  }
}

@Injectable()
class AllowEveryoneGuard implements CanActivate {
  canActivate(_context: ExecutionContext): boolean {
    return true;
  }
}

async function boot(
  dashboardOptions: Parameters<typeof AgentDashboardModule.forRoot>[0],
): Promise<INestApplication> {
  @Module({
    imports: [FakeGovernanceStoreModule, AgentDashboardModule.forRoot(dashboardOptions)],
  })
  class HostRootModule {}

  const app = await NestFactory.create(HostRootModule, { logger: false });
  await app.init();
  return app;
}

const VALID_USER = { username: 'admin', password: 'correct-horse' };

function loginHook(username: string, password: string) {
  return username === VALID_USER.username && password === VALID_USER.password
    ? { id: 'ops', roles: ['admin'] }
    : null;
}

describe('dashboardAuth — end-to-end login round-trip', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  it("absent dashboardAuth: the page and API stay open (today's behavior, unchanged)", async () => {
    app = await boot({});
    const server = app.getHttpServer();

    // The SPA bundle isn't resolvable from the vitest-transformed source path (see
    // `agent-ui.controller.spec.ts`'s own note on this), so "open" shows up as the controller's
    // not-built 404 rather than a 200 — the point is it's NOT a 302 (no auth gate fired).
    await request(server).get('/ai-gateway').expect(404);
    await request(server).get('/ai-gateway/api/runs').expect(200);
    // No built-in login screen mounts at all when the feature is off.
    await request(server).get('/ai-gateway/auth/login').expect(404);
  });

  it('unauthenticated page navigation is redirected (302) to the login screen, API gets 401', async () => {
    app = await boot({ dashboardAuth: { secret: 'sekret-key', login: loginHook } });
    const server = app.getHttpServer();

    const page = await request(server).get('/ai-gateway').expect(302);
    expect(page.headers.location).toBe('/ai-gateway/auth/login?returnTo=%2Fai-gateway');

    await request(server).get('/ai-gateway/api/runs').expect(401);
  });

  it('serves the login form', async () => {
    app = await boot({ dashboardAuth: { secret: 'sekret-key', login: loginHook } });

    const response = await request(app.getHttpServer()).get('/ai-gateway/auth/login').expect(200);

    expect(response.text).toContain('<form method="post" action="/ai-gateway/auth/login">');
  });

  it('rejects bad credentials with a generic, uniform failure — no user enumeration', async () => {
    app = await boot({ dashboardAuth: { secret: 'sekret-key', login: loginHook } });
    const server = app.getHttpServer();

    const unknownUser = await request(server)
      .post('/ai-gateway/auth/login')
      .type('form')
      .send({ username: 'nobody', password: 'whatever' });
    const wrongPassword = await request(server)
      .post('/ai-gateway/auth/login')
      .type('form')
      .send({ username: VALID_USER.username, password: 'wrong' });

    expect(unknownUser.status).toBe(wrongPassword.status);
    expect(unknownUser.headers.location).toBe(wrongPassword.headers.location);
    expect(unknownUser.headers['set-cookie']).toBeUndefined();
    expect(wrongPassword.headers['set-cookie']).toBeUndefined();
  });

  it('good credentials mint a cookie that grants BOTH the page and the API', async () => {
    app = await boot({ dashboardAuth: { secret: 'sekret-key', login: loginHook } });
    const server = app.getHttpServer();

    const login = await request(server)
      .post('/ai-gateway/auth/login')
      .type('form')
      .send({ ...VALID_USER, returnTo: '/ai-gateway' })
      .expect(302);
    const setCookie = login.headers['set-cookie'];
    expect(setCookie).toBeDefined();
    const cookie = (Array.isArray(setCookie) ? setCookie[0] : setCookie) as string;
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);

    // Not a 302 (i.e. the session gate let the request through to the controller) — see the
    // "absent dashboardAuth" spec above for why the not-built SPA shows up as 404 in this env.
    await request(server).get('/ai-gateway').set('Cookie', cookie).expect(404);
    await request(server).get('/ai-gateway/api/runs').set('Cookie', cookie).expect(200);
  });

  it('logout clears the cookie — a subsequent page visit is redirected again', async () => {
    app = await boot({ dashboardAuth: { secret: 'sekret-key', login: loginHook } });
    const server = app.getHttpServer();

    const login = await request(server)
      .post('/ai-gateway/auth/login')
      .type('form')
      .send(VALID_USER);
    const loginCookie = (
      Array.isArray(login.headers['set-cookie'])
        ? login.headers['set-cookie'][0]
        : login.headers['set-cookie']
    ) as string;

    const logout = await request(server)
      .post('/ai-gateway/auth/logout')
      .set('Cookie', loginCookie)
      .expect(302);
    const clearedCookie = (
      Array.isArray(logout.headers['set-cookie'])
        ? logout.headers['set-cookie'][0]
        : logout.headers['set-cookie']
    ) as string;

    await request(server).get('/ai-gateway').set('Cookie', clearedCookie).expect(302);
  });

  it('composes with host `guards`: a denying host guard still wins even with a VALID session (AND semantics)', async () => {
    app = await boot({
      dashboardAuth: { secret: 'sekret-key', login: loginHook },
      guards: [DenyEveryoneGuard],
    });
    const server = app.getHttpServer();

    const login = await request(server)
      .post('/ai-gateway/auth/login')
      .type('form')
      .send(VALID_USER);
    const cookie = (
      Array.isArray(login.headers['set-cookie'])
        ? login.headers['set-cookie'][0]
        : login.headers['set-cookie']
    ) as string;

    // A valid dashboardAuth session is NOT enough on its own — the host guard also runs and denies.
    await request(server).get('/ai-gateway/api/runs').set('Cookie', cookie).expect(403);
  });

  it('composes with host `guards`: an allowing host guard does NOT bypass the session gate', async () => {
    app = await boot({
      dashboardAuth: { secret: 'sekret-key', login: loginHook },
      guards: [AllowEveryoneGuard],
    });
    const server = app.getHttpServer();

    // No session cookie at all — even though the host guard allows everything, dashboardAuth still denies.
    await request(server).get('/ai-gateway/api/runs').expect(401);
  });
});
