import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { ResolvedDashboardAuth } from './dashboard-auth-config.js';
import { resolveDashboardAuth } from './dashboard-auth-config.js';
import { DashboardAuthPageGuard } from './dashboard-auth-page.guard.js';
import { DashboardAuthRedirect } from './dashboard-auth-redirect.js';
import { SESSION_COOKIE_NAME } from './session-cookie-io.js';
import { signSessionCookie } from './session-cookie.js';

const AUTH: ResolvedDashboardAuth = {
  secret: 'secret',
  ttlMs: 60_000,
  modes: ['login'],
  login: () => null,
};
const BASE_PATH = '/ai-gateway';

function fakeContext(
  request: Record<string, unknown>,
  response: Record<string, unknown> = {},
): ExecutionContext {
  return {
    switchToHttp: () => ({
      getRequest: () => request,
      getResponse: () => response,
    }),
  } as unknown as ExecutionContext;
}

function cookieHeader(value: string, originalUrl = '/ai-gateway'): Record<string, unknown> {
  return { headers: { cookie: `${SESSION_COOKIE_NAME}=${value}` }, originalUrl };
}

describe('DashboardAuthPageGuard (page — 302 redirect)', () => {
  it("is a no-op (allows) when dashboardAuth is unconfigured — today's behavior byte-for-byte", () => {
    const guard = new DashboardAuthPageGuard(null, BASE_PATH);

    expect(guard.canActivate(fakeContext({ headers: {}, originalUrl: '/ai-gateway' }))).toBe(true);
  });

  it('throws a redirect to the login page (carrying returnTo) with no cookie', () => {
    const guard = new DashboardAuthPageGuard(AUTH, BASE_PATH);

    try {
      guard.canActivate(fakeContext({ headers: {}, originalUrl: '/ai-gateway/runs?x=1' }));
      expect.unreachable('expected a DashboardAuthRedirect to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DashboardAuthRedirect);
      expect((error as DashboardAuthRedirect).redirectTo).toBe(
        `/ai-gateway/auth/login?returnTo=${encodeURIComponent('/ai-gateway/runs?x=1')}`,
      );
    }
  });

  it('throws the SAME redirect shape for an invalid/tampered cookie', () => {
    const guard = new DashboardAuthPageGuard(AUTH, BASE_PATH);

    expect(() => guard.canActivate(fakeContext(cookieHeader('garbage')))).toThrow(
      DashboardAuthRedirect,
    );
  });

  it('grants + attaches the session for a valid cookie', () => {
    const guard = new DashboardAuthPageGuard(AUTH, BASE_PATH);
    const value = signSessionCookie(
      { id: 'user-1', roles: [] },
      { secret: AUTH.secret, ttlMs: AUTH.ttlMs },
    );
    const request = cookieHeader(value);

    expect(guard.canActivate(fakeContext(request))).toBe(true);
    expect(request.dashboardSession).toMatchObject({ sub: 'user-1' });
  });

  it('redirects to the session-required page when only Mode A is configured', () => {
    const guard = new DashboardAuthPageGuard(
      resolveDashboardAuth({ secret: 's3cr3t', session: () => null }),
      '/ai-gateway',
    );
    expect(() => guard.canActivate(fakeContext({ headers: {} }))).toThrow(
      expect.objectContaining({ redirectTo: '/ai-gateway/auth/session-required' }),
    );
  });
});
