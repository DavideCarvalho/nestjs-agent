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

/** A signed cookie issued far enough in the past to be due for sliding renewal. */
function signedCookieOlderThanHalfTtl(auth: ResolvedDashboardAuth): string {
  const issuedAt = Date.now() - auth.ttlMs * 0.75;
  return signSessionCookie(
    { id: 'ops', roles: ['admin'] },
    { secret: auth.secret, ttlMs: auth.ttlMs, now: issuedAt },
  );
}

describe('DashboardAuthPageGuard (page — 302 redirect)', () => {
  it("is a no-op (allows) when dashboardAuth is unconfigured — today's behavior byte-for-byte", async () => {
    const guard = new DashboardAuthPageGuard(null, BASE_PATH);

    await expect(
      guard.canActivate(fakeContext({ headers: {}, originalUrl: '/ai-gateway' })),
    ).resolves.toBe(true);
  });

  it('throws a redirect to the login page (carrying returnTo) with no cookie', async () => {
    const guard = new DashboardAuthPageGuard(AUTH, BASE_PATH);

    try {
      await guard.canActivate(fakeContext({ headers: {}, originalUrl: '/ai-gateway/runs?x=1' }));
      expect.unreachable('expected a DashboardAuthRedirect to be thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(DashboardAuthRedirect);
      expect((error as DashboardAuthRedirect).redirectTo).toBe(
        `/ai-gateway/auth/login?returnTo=${encodeURIComponent('/ai-gateway/runs?x=1')}`,
      );
    }
  });

  it('throws the SAME redirect shape for an invalid/tampered cookie', async () => {
    const guard = new DashboardAuthPageGuard(AUTH, BASE_PATH);

    await expect(guard.canActivate(fakeContext(cookieHeader('garbage')))).rejects.toThrow(
      DashboardAuthRedirect,
    );
  });

  it('grants + attaches the session for a valid cookie', async () => {
    const guard = new DashboardAuthPageGuard(AUTH, BASE_PATH);
    const value = signSessionCookie(
      { id: 'user-1', roles: [] },
      { secret: AUTH.secret, ttlMs: AUTH.ttlMs },
    );
    const request = cookieHeader(value);

    await expect(guard.canActivate(fakeContext(request))).resolves.toBe(true);
    expect(request.dashboardSession).toMatchObject({ sub: 'user-1' });
  });

  it('redirects to the session-required page when only Mode A is configured', async () => {
    const guard = new DashboardAuthPageGuard(
      resolveDashboardAuth({ secret: 's3cr3t', session: () => null }),
      '/ai-gateway',
    );
    await expect(guard.canActivate(fakeContext({ headers: {} }))).rejects.toThrow(
      expect.objectContaining({ redirectTo: '/ai-gateway/auth/session-required' }),
    );
  });

  it('redirects (not the session-required page) when revalidate revokes a renewable session, Mode B configured', async () => {
    const revalidateAuth = resolveDashboardAuth({
      secret: 's3cr3t',
      login: () => null,
      revalidate: () => false,
    });
    if (!revalidateAuth) throw new Error('expected dashboardAuth to resolve for this test fixture');
    const guard = new DashboardAuthPageGuard(revalidateAuth, BASE_PATH);
    const request = cookieHeader(signedCookieOlderThanHalfTtl(revalidateAuth));

    await expect(guard.canActivate(fakeContext(request))).rejects.toThrow(DashboardAuthRedirect);
  });

  it('serves the session-required page when revalidate revokes a renewable session, Mode A only', async () => {
    const revalidateModeAAuth = resolveDashboardAuth({
      secret: 's3cr3t',
      session: () => null,
      revalidate: () => false,
    });
    if (!revalidateModeAAuth) {
      throw new Error('expected dashboardAuth to resolve for this test fixture');
    }
    const guard = new DashboardAuthPageGuard(revalidateModeAAuth, BASE_PATH);
    const request = cookieHeader(signedCookieOlderThanHalfTtl(revalidateModeAAuth));

    await expect(guard.canActivate(fakeContext(request))).rejects.toThrow(
      expect.objectContaining({ redirectTo: '/ai-gateway/auth/session-required' }),
    );
  });
});
