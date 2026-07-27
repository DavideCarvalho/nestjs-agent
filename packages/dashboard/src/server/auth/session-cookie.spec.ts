import { describe, expect, it, vi } from 'vitest';
import { type DashboardAuthOptions, resolveDashboardAuth } from './dashboard-auth-config.js';
import { maybeRenewSession } from './session-cookie-io.js';
import { signSessionCookie, verifySessionCookie } from './session-cookie.js';

const SECRET = 'a-very-secret-signing-key';

/** `resolveDashboardAuth`, asserting the config was valid (never `null` for these fixtures). */
function resolveAuth(options: DashboardAuthOptions) {
  const auth = resolveDashboardAuth(options);
  if (!auth) throw new Error('expected dashboardAuth to resolve for this test fixture');
  return auth;
}

/** Minimal Node-response double recording Set-Cookie writes, over the `appendSetCookie` contract. */
function mockResponse(): {
  getHeader: (name: string) => unknown;
  setHeader: (name: string, value: unknown) => void;
} {
  const headers: Record<string, unknown> = {};
  return {
    getHeader: (name) => headers[name.toLowerCase()],
    setHeader: (name, value) => {
      headers[name.toLowerCase()] = value;
    },
  };
}

/** Read the queued `Set-Cookie` header(s) off a `mockResponse()`. */
function setCookiesOn(response: ReturnType<typeof mockResponse>): string[] {
  const current = response.getHeader('set-cookie');
  return Array.isArray(current) ? current.filter((c): c is string => typeof c === 'string') : [];
}

describe('signSessionCookie / verifySessionCookie', () => {
  it('round-trips a session', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const cookie = signSessionCookie(
      { id: 'user-1', name: 'Ada', roles: ['admin'] },
      { secret: SECRET, ttlMs: 60_000, now },
    );

    const session = verifySessionCookie(cookie, { secret: SECRET, now });

    expect(session).toEqual({
      sub: 'user-1',
      name: 'Ada',
      roles: ['admin'],
      iat: now,
      exp: now + 60_000,
    });
  });

  it('defaults roles to [] and omits name when absent', () => {
    const now = Date.now();
    const cookie = signSessionCookie({ id: 'user-1' }, { secret: SECRET, ttlMs: 1000, now });

    const session = verifySessionCookie(cookie, { secret: SECRET, now });

    expect(session).toEqual({ sub: 'user-1', roles: [], iat: now, exp: now + 1000 });
  });

  it('rejects a cookie signed with a different secret (tampered)', () => {
    const cookie = signSessionCookie({ id: 'user-1' }, { secret: SECRET, ttlMs: 60_000 });

    expect(verifySessionCookie(cookie, { secret: 'wrong-secret' })).toBeNull();
  });

  it('rejects a cookie with a hand-edited payload (signature no longer matches)', () => {
    const cookie = signSessionCookie({ id: 'user-1' }, { secret: SECRET, ttlMs: 60_000 });
    const [payload, signature] = cookie.split('.');
    const tampered = `${Buffer.from('{"sub":"attacker","roles":[],"iat":0,"exp":9999999999999}').toString('base64url')}.${signature}`;
    expect(payload).toBeDefined();

    expect(verifySessionCookie(tampered, { secret: SECRET })).toBeNull();
  });

  it('rejects an expired cookie past the grace window', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const cookie = signSessionCookie({ id: 'user-1' }, { secret: SECRET, ttlMs: 1000, now });

    // 1000ms ttl + 30s grace: well past both.
    expect(verifySessionCookie(cookie, { secret: SECRET, now: now + 60_000 })).toBeNull();
  });

  it('accepts a cookie within the 30s clock-skew grace past exp', () => {
    const now = Date.parse('2026-01-01T00:00:00Z');
    const cookie = signSessionCookie({ id: 'user-1' }, { secret: SECRET, ttlMs: 1000, now });

    expect(
      verifySessionCookie(cookie, { secret: SECRET, now: now + 1000 + 10_000 }),
    ).not.toBeNull();
  });

  it('never throws on garbage input', () => {
    expect(verifySessionCookie('not-a-cookie', { secret: SECRET })).toBeNull();
    expect(verifySessionCookie('', { secret: SECRET })).toBeNull();
    expect(verifySessionCookie('.', { secret: SECRET })).toBeNull();
    expect(verifySessionCookie('abc.', { secret: SECRET })).toBeNull();
    expect(verifySessionCookie('abc.def', { secret: SECRET })).toBeNull();
  });
});

describe('maybeRenewSession (sliding renewal + revalidation)', () => {
  const HALF_LIFE_PASSED = {
    iat: Date.now() - 5 * 60 * 60 * 1000,
    exp: Date.now() + 3 * 60 * 60 * 1000,
    sub: '7',
    roles: ['admin'],
  };

  it('does not call revalidate before half the TTL has passed', async () => {
    const revalidate = vi.fn().mockResolvedValue(true);
    const auth = resolveAuth({ secret: 's'.repeat(32), session: () => null, revalidate });
    const fresh = { iat: Date.now(), exp: Date.now() + 60 * 60 * 1000, sub: '7', roles: ['admin'] };
    await maybeRenewSession(auth, fresh, { headers: {} }, mockResponse());
    expect(revalidate).not.toHaveBeenCalled();
  });

  it('renews when revalidate approves', async () => {
    const auth = resolveAuth({
      secret: 's'.repeat(32),
      session: () => null,
      revalidate: () => true,
    });
    const response = mockResponse();
    await expect(
      maybeRenewSession(auth, HALF_LIFE_PASSED, { headers: {} }, response),
    ).resolves.toBe(true);
    expect(setCookiesOn(response)[0]).toContain('agent_dashboard_session=');
  });

  it('clears the cookie and denies when revalidate rejects', async () => {
    const auth = resolveAuth({
      secret: 's'.repeat(32),
      session: () => null,
      revalidate: () => false,
    });
    const response = mockResponse();
    await expect(
      maybeRenewSession(auth, HALF_LIFE_PASSED, { headers: {} }, response),
    ).resolves.toBe(false);
    expect(setCookiesOn(response)[0]).toContain('Max-Age=0');
  });

  it('fails closed when revalidate throws', async () => {
    const auth = resolveAuth({
      secret: 's'.repeat(32),
      session: () => null,
      revalidate: () => {
        throw new Error('db down');
      },
    });
    await expect(
      maybeRenewSession(auth, HALF_LIFE_PASSED, { headers: {} }, mockResponse()),
    ).resolves.toBe(false);
  });

  it('renews without a revalidate hook (unchanged behaviour)', async () => {
    const auth = resolveAuth({ secret: 's'.repeat(32), session: () => null });
    await expect(
      maybeRenewSession(auth, HALF_LIFE_PASSED, { headers: {} }, mockResponse()),
    ).resolves.toBe(true);
  });
});
