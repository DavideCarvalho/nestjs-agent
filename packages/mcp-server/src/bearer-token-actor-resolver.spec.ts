import { HttpException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { BearerTokenActorResolver } from './bearer-token-actor-resolver.js';

const CI = { id: 'ci', roles: ['ANALYST'] };
const RELEASE = { id: 'release', roles: ['ADMIN'] };

function resolver() {
  return new BearerTokenActorResolver([
    { token: 'ci-key-0123456789', actor: CI },
    { token: 'release-key-98765', actor: RELEASE },
  ]);
}

function statusOf(headers: Record<string, string>): number {
  try {
    resolver().resolve({ headers });
  } catch (error) {
    if (error instanceof HttpException) {
      return error.getStatus();
    }
    throw error;
  }
  return 0;
}

describe('BearerTokenActorResolver', () => {
  it('resolves each token to the identity it was issued for', () => {
    expect(resolver().resolve({ headers: { authorization: 'Bearer ci-key-0123456789' } })).toEqual(
      CI,
    );
    expect(resolver().resolve({ headers: { authorization: 'Bearer release-key-98765' } })).toEqual(
      RELEASE,
    );
  });

  it('refuses a caller with 401 rather than falling back to an anonymous actor', () => {
    for (const headers of [
      {},
      { authorization: '' },
      { authorization: 'Bearer ' },
      { authorization: 'Bearer wrong-key-012345' },
      { authorization: 'ci-key-0123456789' },
      { authorization: 'Basic ci-key-0123456789' },
    ]) {
      expect(statusOf(headers)).toBe(401);
    }
  });

  it('refuses a request that carries no headers at all', () => {
    expect(() => resolver().resolve({})).toThrow(/Bearer/);
    expect(() => resolver().resolve(undefined)).toThrow(/Bearer/);
  });

  it('refuses a token that is a prefix or an extension of a real one', () => {
    expect(statusOf({ authorization: 'Bearer ci-key-012345678' })).toBe(401);
    expect(statusOf({ authorization: 'Bearer ci-key-01234567890' })).toBe(401);
  });

  it('refuses to be constructed with an empty token', () => {
    // `Authorization: Bearer ` parses to the empty string, so an empty grant would authenticate
    // every caller that knows the endpoint exists.
    expect(() => new BearerTokenActorResolver([{ token: '', actor: CI }])).toThrow(/empty token/);
  });

  it('grants exactly the roles the host put on the grant, and no others', () => {
    const noRoles = new BearerTokenActorResolver([{ token: 'k-000000', actor: { id: 'probe' } }]);
    expect(noRoles.resolve({ headers: { authorization: 'Bearer k-000000' } })).toEqual({
      id: 'probe',
    });
  });
});
