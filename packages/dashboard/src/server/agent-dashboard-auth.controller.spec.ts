import { NotFoundException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { AgentDashboardAuthController } from './agent-dashboard-auth.controller.js';
import type {
  LoginHook,
  ResolvedDashboardAuth,
  SessionHook,
} from './auth/dashboard-auth-config.js';
import { SESSION_COOKIE_NAME } from './auth/session-cookie-io.js';
import { signSessionCookie } from './auth/session-cookie.js';

const BASE_PATH = '/ai-gateway';

/** A recording req/res pair matching the structural slices the controller reads/writes. */
function fakeReqRes(cookieHeader?: string) {
  const statuses: number[] = [];
  const headers: Record<string, string | string[]> = {};
  return {
    req: { headers: cookieHeader !== undefined ? { cookie: cookieHeader } : {} },
    res: {
      status: (code: number) => statuses.push(code),
      setHeader: (name: string, value: string | string[]) => {
        headers[name.toLowerCase()] = value;
      },
      getHeader: (name: string) => headers[name.toLowerCase()],
    },
    statuses,
    headers,
    /** The single `Set-Cookie` string written (this controller only ever issues/clears ONE cookie per response). */
    setCookie: (): string => {
      const value = headers['set-cookie'];
      const first = Array.isArray(value) ? value[0] : value;
      if (first === undefined) throw new Error('no Set-Cookie header was written');
      return first;
    },
  };
}

function makeAuth(login: LoginHook): ResolvedDashboardAuth {
  return { secret: 'secret', ttlMs: 60_000, modes: ['login'], login };
}

function makeSessionAuth(session: SessionHook): ResolvedDashboardAuth {
  return { secret: 'secret', ttlMs: 60_000, modes: ['session'], session };
}

describe('AgentDashboardAuthController', () => {
  describe('when dashboardAuth is unconfigured', () => {
    const controller = new AgentDashboardAuthController(null, BASE_PATH);

    it('404s the login page', () => {
      const { req, res } = fakeReqRes();
      expect(() => controller.loginPage(req, res)).toThrow(NotFoundException);
    });

    it('404s the login POST', async () => {
      const { req, res } = fakeReqRes();
      await expect(controller.login({}, req, res)).rejects.toThrow(NotFoundException);
    });

    it('logout still clears the cookie (best-effort, harmless even when auth is off)', () => {
      const { req, res, statuses, headers } = fakeReqRes();
      controller.logout(req, res);
      expect(statuses).toEqual([302]);
      expect(headers.location).toBe('/ai-gateway/auth/login');
    });
  });

  describe('GET login page', () => {
    it('renders the form, carrying returnTo through as a hidden field', () => {
      const controller = new AgentDashboardAuthController(
        makeAuth(() => null),
        BASE_PATH,
      );
      const { req, res } = fakeReqRes();

      const html = controller.loginPage(req, res, '/ai-gateway/runs');

      expect(html).toContain('<form method="post" action="/ai-gateway/auth/login">');
      expect(html).toContain('name="returnTo" value="/ai-gateway/runs"');
      expect(html).toContain('Sign in');
      expect(html).not.toContain('Invalid username or password');
    });

    it('renders the generic error banner when ?error is present', () => {
      const controller = new AgentDashboardAuthController(
        makeAuth(() => null),
        BASE_PATH,
      );
      const { req, res } = fakeReqRes();

      const html = controller.loginPage(req, res, undefined, '1');

      expect(html).toContain('Invalid username or password.');
    });

    it('falls back returnTo to basePath when the query value points outside it (open-redirect guard)', () => {
      const controller = new AgentDashboardAuthController(
        makeAuth(() => null),
        BASE_PATH,
      );
      const { req, res } = fakeReqRes();

      const html = controller.loginPage(req, res, '//evil.example.com');

      expect(html).toContain('name="returnTo" value="/ai-gateway"');
    });

    it('redirects straight through when a valid session cookie is already present', () => {
      const auth = makeAuth(() => null);
      const controller = new AgentDashboardAuthController(auth, BASE_PATH);
      const cookieValue = signSessionCookie(
        { id: 'user-1' },
        { secret: auth.secret, ttlMs: auth.ttlMs },
      );
      const { req, res, statuses, headers } = fakeReqRes(`${SESSION_COOKIE_NAME}=${cookieValue}`);

      const body = controller.loginPage(req, res, '/ai-gateway/runs');

      expect(statuses).toEqual([302]);
      expect(headers.location).toBe('/ai-gateway/runs');
      expect(body).toBe('');
    });
  });

  describe('POST login', () => {
    it('rejects a malformed body (missing username/password) with the generic redirect', async () => {
      const controller = new AgentDashboardAuthController(
        makeAuth(() => null),
        BASE_PATH,
      );
      const { req, res, statuses, headers } = fakeReqRes();

      await controller.login({}, req, res);

      expect(statuses).toEqual([303]);
      expect(headers.location).toMatch(/^\/ai-gateway\/auth\/login\?error=1&returnTo=/);
      expect(headers['set-cookie']).toBeUndefined();
    });

    it('rejects bad credentials and sets NO cookie', async () => {
      const controller = new AgentDashboardAuthController(
        makeAuth(() => null),
        BASE_PATH,
      );
      const { req, res, statuses, headers } = fakeReqRes();

      await controller.login({ username: 'admin', password: 'wrong' }, req, res);

      expect(statuses).toEqual([303]);
      expect(headers['set-cookie']).toBeUndefined();
    });

    it('responds IDENTICALLY for an unknown user and a wrong password (no user enumeration)', async () => {
      // The hook is the single source of truth here — both branches return `null` through the
      // exact same controller code path, so the two responses are byte-identical by construction.
      const controller = new AgentDashboardAuthController(
        makeAuth((username, password) =>
          username === 'admin' && password === 'correct-horse' ? { id: 'ops' } : null,
        ),
        BASE_PATH,
      );

      const unknownUser = fakeReqRes();
      await controller.login(
        { username: 'nobody', password: 'whatever' },
        unknownUser.req,
        unknownUser.res,
      );

      const wrongPassword = fakeReqRes();
      await controller.login(
        { username: 'admin', password: 'wrong' },
        wrongPassword.req,
        wrongPassword.res,
      );

      expect(unknownUser.statuses).toEqual(wrongPassword.statuses);
      expect(unknownUser.headers.location).toBe(wrongPassword.headers.location);
    });

    it('password is optional: an empty password reaches the hook AS-IS (spy sees "")', async () => {
      const loginSpy = vi.fn(() => null);
      const controller = new AgentDashboardAuthController(makeAuth(loginSpy), BASE_PATH);
      const { req, res } = fakeReqRes();

      await controller.login({ username: 'admin@example.com', password: '' }, req, res);

      expect(loginSpy).toHaveBeenCalledWith('admin@example.com', '');
    });

    it('password is optional: an omitted password reaches the hook as "" too', async () => {
      const loginSpy = vi.fn(() => null);
      const controller = new AgentDashboardAuthController(makeAuth(loginSpy), BASE_PATH);
      const { req, res } = fakeReqRes();

      await controller.login({ username: 'admin@example.com' }, req, res);

      expect(loginSpy).toHaveBeenCalledWith('admin@example.com', '');
    });

    it('a hook that rejects an empty password still uniform-fails (no cookie, generic redirect)', async () => {
      const controller = new AgentDashboardAuthController(
        makeAuth((username, password) =>
          username === 'admin' && password === 'correct-horse' ? { id: 'ops' } : null,
        ),
        BASE_PATH,
      );
      const { req, res, statuses, headers } = fakeReqRes();

      await controller.login({ username: 'admin', password: '' }, req, res);

      expect(statuses).toEqual([303]);
      expect(headers.location).toMatch(/^\/ai-gateway\/auth\/login\?error=1&returnTo=/);
      expect(headers['set-cookie']).toBeUndefined();
    });

    it('a hook that accepts an empty password (username/email-only policy) mints the session', async () => {
      const controller = new AgentDashboardAuthController(
        makeAuth((username, password) =>
          username === 'admin@example.com' && password === '' ? { id: 'ops' } : null,
        ),
        BASE_PATH,
      );
      const { req, res, statuses, headers, setCookie } = fakeReqRes();

      await controller.login(
        { username: 'admin@example.com', password: '', returnTo: '/ai-gateway/runs' },
        req,
        res,
      );

      expect(statuses).toEqual([302]);
      expect(headers.location).toBe('/ai-gateway/runs');
      expect(setCookie()).toContain(`${SESSION_COOKIE_NAME}=`);
    });

    it('rejects a malformed password shape (not a string) with the generic redirect', async () => {
      const controller = new AgentDashboardAuthController(
        makeAuth(() => ({ id: 'ops' })),
        BASE_PATH,
      );
      const { req, res, statuses, headers } = fakeReqRes();

      await controller.login({ username: 'admin', password: ['x'] }, req, res);

      expect(statuses).toEqual([303]);
      expect(headers['set-cookie']).toBeUndefined();
    });

    it('a login hook that throws is treated as a denial, not a 500', async () => {
      const controller = new AgentDashboardAuthController(
        makeAuth(() => {
          throw new Error('DB is down');
        }),
        BASE_PATH,
      );
      const { req, res, statuses } = fakeReqRes();

      await controller.login({ username: 'admin', password: 'x' }, req, res);

      expect(statuses).toEqual([303]);
    });

    it('good credentials set the session cookie and redirect to returnTo', async () => {
      const controller = new AgentDashboardAuthController(
        makeAuth((username, password) =>
          username === 'admin' && password === 'correct-horse'
            ? { id: 'ops', roles: ['admin'] }
            : null,
        ),
        BASE_PATH,
      );
      const { req, res, statuses, headers, setCookie } = fakeReqRes();

      await controller.login(
        { username: 'admin', password: 'correct-horse', returnTo: '/ai-gateway/runs' },
        req,
        res,
      );

      expect(statuses).toEqual([302]);
      expect(headers.location).toBe('/ai-gateway/runs');
      expect(setCookie()).toContain(`${SESSION_COOKIE_NAME}=`);
    });
  });

  describe('POST logout', () => {
    it('clears the cookie and redirects to the login page (Mode B / both modes)', () => {
      const controller = new AgentDashboardAuthController(
        makeAuth(() => null),
        BASE_PATH,
      );
      const { req, res, statuses, headers, setCookie } = fakeReqRes(
        `${SESSION_COOKIE_NAME}=whatever`,
      );

      controller.logout(req, res);

      expect(statuses).toEqual([302]);
      expect(headers.location).toBe('/ai-gateway/auth/login');
      expect(setCookie()).toContain('Max-Age=0');
    });

    it('redirects to session-required (not the 404-ing login page) under Mode-A-only', () => {
      const controller = new AgentDashboardAuthController(
        makeSessionAuth(() => null),
        BASE_PATH,
      );
      const { req, res, statuses, headers, setCookie } = fakeReqRes(
        `${SESSION_COOKIE_NAME}=whatever`,
      );

      controller.logout(req, res);

      expect(statuses).toEqual([302]);
      expect(headers.location).toBe('/ai-gateway/auth/session-required');
      expect(setCookie()).toContain('Max-Age=0');
    });
  });

  describe('POST session (Mode A)', () => {
    it('mints the cookie when the hook returns a user', async () => {
      const controller = new AgentDashboardAuthController(
        makeSessionAuth(() => ({ id: 'ops' })),
        BASE_PATH,
      );
      const { req, res, setCookie } = fakeReqRes();

      await controller.session(req, res);

      expect(setCookie()).toContain(`${SESSION_COOKIE_NAME}=`);
    });

    it('401s when the hook returns null', async () => {
      const controller = new AgentDashboardAuthController(
        makeSessionAuth(() => null),
        BASE_PATH,
      );
      const { req, res, headers } = fakeReqRes();

      await expect(controller.session(req, res)).rejects.toThrow(UnauthorizedException);
      expect(headers['set-cookie']).toBeUndefined();
    });

    it('401s rather than 500s when the hook throws', async () => {
      const controller = new AgentDashboardAuthController(
        makeSessionAuth(() => {
          throw new Error('upstream identity provider is down');
        }),
        BASE_PATH,
      );
      const { req, res, headers } = fakeReqRes();

      await expect(controller.session(req, res)).rejects.toThrow(UnauthorizedException);
      expect(headers['set-cookie']).toBeUndefined();
    });

    it('404s when only Mode B (login) is configured', async () => {
      const controller = new AgentDashboardAuthController(
        makeAuth(() => null),
        BASE_PATH,
      );
      const { req, res } = fakeReqRes();

      await expect(controller.session(req, res)).rejects.toThrow(NotFoundException);
    });
  });

  describe('GET login (Mode-A-only mount)', () => {
    it('404s when only Mode A (session) is configured', () => {
      const controller = new AgentDashboardAuthController(
        makeSessionAuth(() => null),
        BASE_PATH,
      );
      const { req, res } = fakeReqRes();

      expect(() => controller.loginPage(req, res)).toThrow(NotFoundException);
    });
  });
});
