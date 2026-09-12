import { type HttpException, UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { HeaderActorResolver } from './header-actor-resolver.js';

function req(headers: Record<string, string>): { headers: Record<string, string> } {
  return { headers };
}

describe('HeaderActorResolver', () => {
  const resolver = new HeaderActorResolver();

  it('resolves id, comma-separated roles, and tenantRef from headers', () => {
    const actor = resolver.resolve(
      req({ 'x-actor-id': 'u1', 'x-actor-role': 'ADMIN, ANALYST', 'x-tenant-ref': 'berlin' }),
    );
    expect(actor).toEqual({ id: 'u1', roles: ['ADMIN', 'ANALYST'], tenantRef: 'berlin' });
  });

  it('grants no roles when x-actor-role is absent (fail-closed, never ADMIN)', () => {
    const actor = resolver.resolve(req({ 'x-actor-id': 'u1' }));
    expect(actor).toEqual({ id: 'u1', roles: [] });
  });

  it('throws when x-actor-id is missing — never fabricates an identity', () => {
    expect(() => resolver.resolve(req({ 'x-actor-role': 'ADMIN' }))).toThrow(/x-actor-id/);
  });

  it('rejects an unidentified caller as 401, not as a 500', () => {
    // A plain Error reaches the client as "Internal server error" with a logged stack: it
    // misreports the request and makes every anonymous probe look like a server fault.
    for (const request of [req({ 'x-actor-role': 'ADMIN' }), {}, req({ 'x-actor-id': '' })]) {
      expect(() => resolver.resolve(request)).toThrow(UnauthorizedException);
      try {
        resolver.resolve(request);
        expect.unreachable('resolve must reject an unidentified caller');
      } catch (error) {
        expect((error as HttpException).getStatus()).toBe(401);
      }
    }
  });

  it('throws when the request has no headers at all', () => {
    expect(() => resolver.resolve({})).toThrow(/x-actor-id/);
  });
});
