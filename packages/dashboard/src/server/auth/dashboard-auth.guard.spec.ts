import 'reflect-metadata';
import type { ExecutionContext } from '@nestjs/common';
import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import type { ResolvedDashboardAuth } from './dashboard-auth-config.js';
import { DashboardAuthGuard } from './dashboard-auth.guard.js';
import { SESSION_COOKIE_NAME } from './session-cookie-io.js';
import { signSessionCookie } from './session-cookie.js';

const AUTH: ResolvedDashboardAuth = { secret: 'secret', ttlMs: 60_000, login: () => null };

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

describe('DashboardAuthGuard (API — 401)', () => {
  it("is a no-op (allows) when dashboardAuth is unconfigured — today's behavior byte-for-byte", () => {
    const guard = new DashboardAuthGuard(null);

    expect(guard.canActivate(fakeContext({ headers: {} }))).toBe(true);
  });

  it('denies (401) with no cookie when dashboardAuth IS configured', () => {
    const guard = new DashboardAuthGuard(AUTH);

    expect(() => guard.canActivate(fakeContext({ headers: {} }))).toThrow(UnauthorizedException);
  });

  it('denies (401) an invalid/tampered cookie', () => {
    const guard = new DashboardAuthGuard(AUTH);

    expect(() => guard.canActivate(fakeContext(cookieHeader('garbage')))).toThrow(
      UnauthorizedException,
    );
  });

  it('grants + attaches the session for a valid cookie', () => {
    const guard = new DashboardAuthGuard(AUTH);
    const value = signSessionCookie(
      { id: 'user-1', roles: ['admin'] },
      { secret: AUTH.secret, ttlMs: AUTH.ttlMs },
    );
    const request = cookieHeader(value);

    expect(guard.canActivate(fakeContext(request))).toBe(true);
    expect(request.dashboardSession).toMatchObject({ sub: 'user-1', roles: ['admin'] });
  });
});
