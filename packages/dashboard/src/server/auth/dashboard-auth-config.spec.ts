import { describe, expect, it } from 'vitest';
import { resolveDashboardAuth } from './dashboard-auth-config.js';

describe('resolveDashboardAuth', () => {
  it('returns null when dashboardAuth is not configured — the console stays open, unchanged', () => {
    expect(resolveDashboardAuth(undefined)).toBeNull();
  });

  it('resolves secret/ttl/login when fully configured', () => {
    const login = () => null;
    const resolved = resolveDashboardAuth({ secret: 's3cr3t', ttl: '30m', login });

    expect(resolved).toEqual({ secret: 's3cr3t', ttlMs: 30 * 60_000, modes: ['login'], login });
  });

  it('defaults ttl to 8h when omitted', () => {
    const resolved = resolveDashboardAuth({ secret: 's3cr3t', login: () => null });

    expect(resolved?.ttlMs).toBe(8 * 60 * 60_000);
  });

  it('throws (fail closed) when secret is missing', () => {
    expect(() => resolveDashboardAuth({ secret: '', login: () => null })).toThrow(/secret/i);
  });

  it('throws on an unparseable ttl', () => {
    expect(() =>
      resolveDashboardAuth({ secret: 's3cr3t', ttl: 'banana', login: () => null }),
    ).toThrow(/ttl/i);
  });

  it('resolves with only a session hook (Mode A)', () => {
    const session = () => null;
    const resolved = resolveDashboardAuth({ secret: 's3cr3t', session });
    expect(resolved).toEqual({
      secret: 's3cr3t',
      ttlMs: 8 * 60 * 60 * 1000,
      modes: ['session'],
      session,
    });
  });

  it('resolves with both hooks and reports both modes', () => {
    const resolved = resolveDashboardAuth({
      secret: 's3cr3t',
      session: () => null,
      login: () => null,
    });
    expect(resolved?.modes).toEqual(['session', 'login']);
  });

  it('throws (fail closed) when neither hook is given', () => {
    expect(() => resolveDashboardAuth({ secret: 's3cr3t' })).toThrow(/at least one of/i);
  });

  it('throws (fail closed) when session is present but not a function', () => {
    expect(() =>
      resolveDashboardAuth({
        secret: 's3cr3t',
        // @ts-expect-error — exercising the runtime guard for a non-TS caller
        session: 'not-a-function',
      }),
    ).toThrow(/`session` must be a function/);
  });

  it('throws (fail closed) when login is present but not a function', () => {
    expect(() =>
      resolveDashboardAuth({
        secret: 's3cr3t',
        // @ts-expect-error — exercising the runtime guard for a non-TS caller
        login: 'not-a-function',
      }),
    ).toThrow(/`login` must be a function/);
  });
});
