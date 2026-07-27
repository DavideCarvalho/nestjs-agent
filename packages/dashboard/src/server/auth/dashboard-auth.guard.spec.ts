import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { type ResolvedDashboardAuth, resolveDashboardAuth } from './dashboard-auth-config.js';
import { DashboardAuthGuard } from './dashboard-auth.guard.js';
import { SESSION_COOKIE_NAME } from './session-cookie-io.js';
import { signSessionCookie } from './session-cookie.js';

const AUTH: ResolvedDashboardAuth = {
  secret: 'secret',
  ttlMs: 60_000,
  modes: ['login'],
  login: () => null,
};

/** A minimal ExecutionContext wrapping a fake req/res pair, matching what `switchToHttp()` reads. */
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

function cookieHeader(value: string): Record<string, unknown> {
  return { headers: { cookie: `${SESSION_COOKIE_NAME}=${value}` } };
}

/** A signed cookie issued far enough in the past to be due for sliding renewal. */
function signedCookieOlderThanHalfTtl(auth: ResolvedDashboardAuth): string {
  const issuedAt = Date.now() - auth.ttlMs * 0.75;
  return signSessionCookie(
    { id: 'ops', roles: ['admin'] },
    { secret: auth.secret, ttlMs: auth.ttlMs, now: issuedAt },
  );
}

describe('DashboardAuthGuard (API — 401)', () => {
  it("is a no-op (allows) when dashboardAuth is unconfigured — today's behavior byte-for-byte", async () => {
    const guard = new DashboardAuthGuard(null);

    await expect(guard.canActivate(fakeContext({ headers: {} }))).resolves.toBe(true);
  });

  it('denies (401) with no cookie when dashboardAuth IS configured', async () => {
    const guard = new DashboardAuthGuard(AUTH);

    await expect(guard.canActivate(fakeContext({ headers: {} }))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('denies (401) an invalid/tampered cookie', async () => {
    const guard = new DashboardAuthGuard(AUTH);

    await expect(guard.canActivate(fakeContext(cookieHeader('garbage')))).rejects.toThrow(
      UnauthorizedException,
    );
  });

  it('grants + attaches the session for a valid cookie', async () => {
    const guard = new DashboardAuthGuard(AUTH);
    const value = signSessionCookie(
      { id: 'user-1', roles: ['admin'] },
      { secret: AUTH.secret, ttlMs: AUTH.ttlMs },
    );
    const request = cookieHeader(value);

    await expect(guard.canActivate(fakeContext(request))).resolves.toBe(true);
    expect(request.dashboardSession).toMatchObject({ sub: 'user-1', roles: ['admin'] });
  });

  it('401s when revalidate revokes a renewable session', async () => {
    const auth = resolveDashboardAuth({
      secret: 's3cr3t',
      session: () => null,
      revalidate: () => false,
    });
    if (!auth) throw new Error('expected dashboardAuth to resolve for this test fixture');
    const guard = new DashboardAuthGuard(auth);
    const request = cookieHeader(signedCookieOlderThanHalfTtl(auth));

    await expect(guard.canActivate(fakeContext(request))).rejects.toThrow(UnauthorizedException);
  });
});
