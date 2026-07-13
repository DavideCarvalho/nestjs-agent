import { describe, expect, it } from 'vitest';
import { signSessionCookie, verifySessionCookie } from './session-cookie.js';

const SECRET = 'a-very-secret-signing-key';

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
