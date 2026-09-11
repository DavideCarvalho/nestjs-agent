import { describe, expect, it } from 'vitest';
import {
  type McpAuthInfo,
  McpUnauthenticatedError,
  actorFromAuthInfo,
  isActor,
} from './mcp-actor.js';

const AUTH_FIELDS = { token: 't', clientId: 'c', scopes: [] };

describe('isActor', () => {
  it('accepts an actor with only an id, and one with roles and a tenant', () => {
    expect(isActor({ id: 'u1' })).toBe(true);
    expect(isActor({ id: 'u1', roles: ['ADMIN'], tenantRef: 'acme' })).toBe(true);
  });

  it('rejects anything that is not an object', () => {
    for (const value of [null, undefined, 'u1', 42, true, ['u1']]) {
      expect(isActor(value)).toBe(false);
    }
  });

  it('rejects a missing, non-string, or EMPTY id', () => {
    // An empty id identifies nobody, and every downstream key (quota, memory scope, audit row)
    // would be the empty string.
    expect(isActor({})).toBe(false);
    expect(isActor({ id: 42 })).toBe(false);
    expect(isActor({ id: '' })).toBe(false);
  });

  it('rejects roles that are not an array of strings', () => {
    expect(isActor({ id: 'u1', roles: 'ADMIN' })).toBe(false);
    expect(isActor({ id: 'u1', roles: ['ADMIN', 42] })).toBe(false);
  });
});

describe('actorFromAuthInfo', () => {
  it('reads the actor the transport authenticated', () => {
    const authInfo: McpAuthInfo = { ...AUTH_FIELDS, extra: { actor: { id: 'u1', roles: ['A'] } } };
    expect(actorFromAuthInfo(authInfo)).toEqual({ id: 'u1', roles: ['A'] });
  });

  it('refuses a request with no identity instead of inventing one', () => {
    for (const authInfo of [
      undefined,
      AUTH_FIELDS,
      { ...AUTH_FIELDS, extra: {} },
      { ...AUTH_FIELDS, extra: { actor: { id: 42 } } },
      { ...AUTH_FIELDS, extra: { actor: { id: '' } } },
    ]) {
      expect(() => actorFromAuthInfo(authInfo)).toThrow(McpUnauthenticatedError);
    }
  });
});
