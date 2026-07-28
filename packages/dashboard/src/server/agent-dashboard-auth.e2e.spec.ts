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
import { signSessionCookie } from './auth/session-cookie.js';

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

  it('password is optional: a username/email-only login hook accepts an empty password over HTTP', async () => {
    app = await boot({
      dashboardAuth: {
        secret: 'sekret-key',
        // Mirrors flip's email-only policy: password is deliberately ignored by the host hook.
        login: (username: string) => (username === 'admin@example.com' ? { id: 'ops' } : null),
      },
    });
    const server = app.getHttpServer();

    const login = await request(server)
      .post('/ai-gateway/auth/login')
      .type('form')
      .send({ username: 'admin@example.com', password: '' })
      .expect(302);

    expect(login.headers['set-cookie']).toBeDefined();
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

describe('dashboardAuth — Mode A + revalidate end-to-end', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  const SECRET = 'sekret-key';
  /** Matches `resolveDashboardAuth`'s default `ttl` ('8h') so the stale-cookie helper below lines up. */
  const DEFAULT_TTL_MS = 8 * 60 * 60 * 1000;

  /** A signed cookie header value issued far enough in the past to be due for sliding renewal. */
  function staleSessionCookieHeader(ttlMs: number = DEFAULT_TTL_MS): string {
    const value = signSessionCookie(
      { id: 'ops', roles: ['admin'] },
      { secret: SECRET, ttlMs, now: Date.now() - ttlMs * 0.75 },
    );
    return `${SESSION_COOKIE_NAME}=${value}`;
  }

  function firstSetCookie(response: request.Response): string {
    const raw = response.headers['set-cookie'];
    const first = Array.isArray(raw) ? raw[0] : raw;
    if (first === undefined) throw new Error('no Set-Cookie header was written');
    return first;
  }

  it('Mode-A-only page navigation redirects to session-required, which serves the instruction page', async () => {
    app = await boot({ dashboardAuth: { secret: SECRET, session: () => null } });
    const server = app.getHttpServer();

    const page = await request(server).get('/ai-gateway').expect(302);
    expect(page.headers.location).toBe('/ai-gateway/auth/session-required');

    // Follow the redirect target as a literal (not `page.headers.location`, typed
    // `string | undefined` by supertest) — the assertion above already pins it exactly.
    const instructions = await request(server).get('/ai-gateway/auth/session-required').expect(200);
    expect(instructions.text).toContain('Open this console from your application');
  });

  it('POST /auth/session mints a cookie that grants API access', async () => {
    app = await boot({
      dashboardAuth: { secret: SECRET, session: () => ({ id: 'ops', roles: ['admin'] }) },
    });
    const server = app.getHttpServer();

    const session = await request(server).post('/ai-gateway/auth/session').expect(204);
    const cookie = firstSetCookie(session);
    expect(cookie).toContain(`${SESSION_COOKIE_NAME}=`);

    await request(server).get('/ai-gateway/api/runs').set('Cookie', cookie).expect(200);
  });

  it('Mode-B-only: session-required and POST /auth/session both 404 (no Mode A configured)', async () => {
    app = await boot({ dashboardAuth: { secret: SECRET, login: loginHook } });
    const server = app.getHttpServer();

    await request(server).get('/ai-gateway/auth/session-required').expect(404);
    await request(server).post('/ai-gateway/auth/session').expect(404);
  });

  it('revalidate returning false on the API: 401 + a clearing (Max-Age=0) cookie', async () => {
    app = await boot({
      dashboardAuth: { secret: SECRET, login: loginHook, revalidate: () => false },
    });
    const server = app.getHttpServer();

    const response = await request(server)
      .get('/ai-gateway/api/runs')
      .set('Cookie', staleSessionCookieHeader())
      .expect(401);

    expect(firstSetCookie(response)).toContain('Max-Age=0');
  });

  it('revalidate returning false on a Mode-A page navigation: 302 to session-required + a clearing cookie', async () => {
    app = await boot({
      dashboardAuth: { secret: SECRET, session: () => null, revalidate: () => false },
    });
    const server = app.getHttpServer();

    const response = await request(server)
      .get('/ai-gateway')
      .set('Cookie', staleSessionCookieHeader())
      .expect(302);

    expect(response.headers.location).toBe('/ai-gateway/auth/session-required');
    expect(firstSetCookie(response)).toContain('Max-Age=0');
  });

  it('both modes configured: page nav redirects to the login screen, session-required 404s, POST /auth/session still 204s', async () => {
    app = await boot({
      dashboardAuth: { secret: SECRET, login: loginHook, session: () => ({ id: 'ops' }) },
    });
    const server = app.getHttpServer();

    const page = await request(server).get('/ai-gateway').expect(302);
    expect(page.headers.location).toBe('/ai-gateway/auth/login?returnTo=%2Fai-gateway');

    await request(server).get('/ai-gateway/auth/session-required').expect(404);
    await request(server).post('/ai-gateway/auth/session').expect(204);
  });

  it('Mode-A-only logout redirects to session-required (not the 404-ing login page), and following it resolves', async () => {
    app = await boot({ dashboardAuth: { secret: SECRET, session: () => ({ id: 'ops' }) } });
    const server = app.getHttpServer();

    const logout = await request(server).post('/ai-gateway/auth/logout').expect(302);
    expect(logout.headers.location).toBe('/ai-gateway/auth/session-required');

    // Literal, not `logout.headers.location` (typed `string | undefined`) — see the assertion above.
    await request(server).get('/ai-gateway/auth/session-required').expect(200);
  });
});

describe('dashboardAuth — unauthenticatedPage (host-rendered) end-to-end', () => {
  let app: INestApplication;

  afterEach(async () => {
    await app?.close();
  });

  const SECRET = 'sekret-key';

  /** Express `Response` surface the hooks below use; the spec never imports Express itself. */
  interface HostResponse {
    status(code: number): HostResponse;
    type(value: string): HostResponse;
    send(body: string): unknown;
  }

  it('serves the host page at session-required instead of the built-in card', async () => {
    app = await boot({
      dashboardAuth: {
        secret: SECRET,
        session: () => null,
        unauthenticatedPage: ({ response }) => {
          (response as HostResponse)
            .status(401)
            .type('html')
            .send('<html><body>Open the AI gateway from /ctrl/consoles</body></html>');
        },
      },
    });
    const server = app.getHttpServer();

    // The flow that reaches the page is unchanged: a denied navigation still bounces here.
    const page = await request(server).get('/ai-gateway').expect(302);
    expect(page.headers.location).toBe('/ai-gateway/auth/session-required');

    const hosted = await request(server).get('/ai-gateway/auth/session-required').expect(401);
    // What changed is the CONTENT: the host's bytes, and none of the library's.
    expect(hosted.text).toContain('Open the AI gateway from /ctrl/consoles');
    expect(hosted.text).not.toContain('Open this console from your application');
  });

  it('receives the basePath and the live request/response', async () => {
    let seen: { basePath: string; hasRequest: boolean; hasResponse: boolean } | undefined;
    app = await boot({
      dashboardAuth: {
        secret: SECRET,
        session: () => null,
        unauthenticatedPage: ({ request: req, response, basePath }) => {
          seen = {
            basePath,
            hasRequest: typeof (req as { url?: unknown })?.url === 'string',
            hasResponse: typeof (response as HostResponse)?.send === 'function',
          };
          (response as HostResponse).status(401).send('ok');
        },
      },
    });

    await request(app.getHttpServer()).get('/ai-gateway/auth/session-required').expect(401);
    expect(seen).toEqual({ basePath: '/ai-gateway', hasRequest: true, hasResponse: true });
  });

  it('awaits an async host page rather than racing it', async () => {
    app = await boot({
      dashboardAuth: {
        secret: SECRET,
        session: () => null,
        unauthenticatedPage: async ({ response }) => {
          await new Promise((resolve) => setTimeout(resolve, 5));
          (response as HostResponse).status(401).send('<html>async host page</html>');
        },
      },
    });

    // Without the await, the built-in page would be written the moment the hook yielded — a bug
    // that a synchronous hook can never reveal.
    const hosted = await request(app.getHttpServer())
      .get('/ai-gateway/auth/session-required')
      .expect(401);
    expect(hosted.text).toContain('async host page');
  });

  it('falls back to the built-in page when the host page throws', async () => {
    app = await boot({
      dashboardAuth: {
        secret: SECRET,
        session: () => null,
        unauthenticatedPage: () => {
          throw new Error('template blew up');
        },
      },
    });

    // A broken host page must not turn a denial into a 500 — and above all must not open the
    // console. The visitor still gets a page.
    const fallback = await request(app.getHttpServer())
      .get('/ai-gateway/auth/session-required')
      .expect(200);
    expect(fallback.text).toContain('Open this console from your application');
  });

  it('falls back to the built-in page when the host page writes nothing', async () => {
    app = await boot({
      dashboardAuth: { secret: SECRET, session: () => null, unauthenticatedPage: () => {} },
    });

    // Otherwise the request hangs until the client gives up, with nothing logged anywhere.
    const fallback = await request(app.getHttpServer())
      .get('/ai-gateway/auth/session-required')
      .expect(200);
    expect(fallback.text).toContain('Open this console from your application');
  });

  it('still 404s under Mode B, where there is no session-required page to customise', async () => {
    app = await boot({
      dashboardAuth: {
        secret: SECRET,
        login: () => ({ id: 'ops' }),
        unauthenticatedPage: ({ response }) => {
          (response as HostResponse).status(401).send('should never render');
        },
      },
    });

    // Mode B denies a navigation by redirecting to its own login form; session-required does not
    // exist. Configuring a page hook must not conjure the route into being.
    await request(app.getHttpServer()).get('/ai-gateway/auth/session-required').expect(404);
  });

  it('cannot grant access: the API stays 401 and the console stays closed', async () => {
    app = await boot({
      dashboardAuth: {
        secret: SECRET,
        session: () => null,
        unauthenticatedPage: ({ response }) => {
          (response as HostResponse).status(200).send('<html>my page</html>');
        },
      },
    });
    const server = app.getHttpServer();

    // Even with the host answering 200 on its own page, nothing about the gate moved: the API is
    // still 401 and a page navigation is still bounced.
    await request(server).get('/ai-gateway/api/runs').expect(401);
    await request(server).get('/ai-gateway').expect(302);
  });
});
