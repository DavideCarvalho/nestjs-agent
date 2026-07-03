import { describe, expect, it } from 'vitest';
import { HeaderActorResolver } from './header-actor-resolver.js';
import { UnconfiguredActorResolver } from './unconfigured-actor-resolver.js';

function req(headers: Record<string, string>): { headers: Record<string, string> } {
  return { headers };
}

describe('HeaderActorResolver', () => {
  const resolver = new HeaderActorResolver();

  it('resolves id, comma-separated roles, and tenantRef from headers', () => {
    const actor = resolver.resolve(
      req({ 'x-actor-id': 'u1', 'x-actor-role': 'ADMIN, ANALYST', 'x-tenant-ref': 'base-7' }),
    );
    expect(actor).toEqual({ id: 'u1', roles: ['ADMIN', 'ANALYST'], tenantRef: 'base-7' });
  });

  it('grants no roles when x-actor-role is absent (fail-closed, never ADMIN)', () => {
    const actor = resolver.resolve(req({ 'x-actor-id': 'u1' }));
    expect(actor).toEqual({ id: 'u1', roles: [] });
  });

  it('throws when x-actor-id is missing — never fabricates an identity', () => {
    expect(() => resolver.resolve(req({ 'x-actor-role': 'ADMIN' }))).toThrow(/x-actor-id/);
  });

  it('throws when the request has no headers at all', () => {
    expect(() => resolver.resolve({})).toThrow(/x-actor-id/);
  });
});

describe('UnconfiguredActorResolver', () => {
  it('throws on every request — the secure default refuses to invent a caller', () => {
    const resolver = new UnconfiguredActorResolver();
    expect(() => resolver.resolve()).toThrow(/No actorResolver configured/);
  });
});
