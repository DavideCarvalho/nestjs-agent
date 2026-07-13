import { describe, expect, it } from 'vitest';
import { resolveDashboardAuth } from './dashboard-auth-config.js';

describe('resolveDashboardAuth', () => {
  it('returns null when dashboardAuth is not configured — the console stays open, unchanged', () => {
    expect(resolveDashboardAuth(undefined)).toBeNull();
  });

  it('resolves secret/ttl/login when fully configured', () => {
    const login = () => null;
    const resolved = resolveDashboardAuth({ secret: 's3cr3t', ttl: '30m', login });

    expect(resolved).toEqual({ secret: 's3cr3t', ttlMs: 30 * 60_000, login });
  });

  it('defaults ttl to 8h when omitted', () => {
    const resolved = resolveDashboardAuth({ secret: 's3cr3t', login: () => null });

    expect(resolved?.ttlMs).toBe(8 * 60 * 60_000);
  });

  it('throws (fail closed) when secret is missing', () => {
    expect(() => resolveDashboardAuth({ secret: '', login: () => null })).toThrow(/secret/i);
  });

  it('throws (fail closed) when login is missing', () => {
    // @ts-expect-error — exercising the runtime guard for a host that skips the required hook
    expect(() => resolveDashboardAuth({ secret: 's3cr3t' })).toThrow(/login/i);
  });

  it('throws on an unparseable ttl', () => {
    expect(() =>
      resolveDashboardAuth({ secret: 's3cr3t', ttl: 'banana', login: () => null }),
    ).toThrow(/ttl/i);
  });
});
