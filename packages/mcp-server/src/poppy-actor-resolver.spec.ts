import { describe, expect, it } from 'vitest';
import { McpChallengeException } from './mcp-challenge.js';
import {
  type PoppyPrincipal,
  asPersonalAgent,
  poppyActorResolver,
} from './poppy-actor-resolver.js';

const signedIn: PoppyPrincipal = {
  userId: 'u-1',
  accountId: 'acc-1',
  clientId: 'https://agent.example/agent.json',
  scopes: ['poppy:read', 'orders:read'],
  sessionId: 's-1',
  signedIn: true,
};

const req = (authorization?: string) => ({
  method: 'POST',
  url: '/mcp?x=1',
  headers: { host: 'app.example.com', ...(authorization ? { authorization } : {}) },
});

describe('asPersonalAgent', () => {
  it('adds personal_agent and one scope: role per scope, keeping the actor’s own', () => {
    expect(
      asPersonalAgent({ id: 'a', roles: ['account:a'] }, ['poppy:read', 'orders:read']),
    ).toEqual({
      id: 'a',
      roles: ['account:a', 'personal_agent', 'scope:poppy:read', 'scope:orders:read'],
    });
  });
});

describe('poppyActorResolver', () => {
  it('hands the verifier the public URL without its query, and acts as the account', async () => {
    const seen: unknown[] = [];
    const resolver = poppyActorResolver({
      authenticate: async (request) => {
        seen.push(request);
        return { ok: true, principal: signedIn };
      },
    });
    expect(await resolver.resolve(req('Bearer t'))).toEqual({
      id: 'acc-1',
      roles: ['personal_agent', 'scope:poppy:read', 'scope:orders:read'],
    });
    expect(seen[0]).toMatchObject({ method: 'POST', url: 'http://app.example.com/mcp' });
  });

  it('prefers the actor the authorization server answered, then toActor', async () => {
    const withActor = poppyActorResolver({
      authenticate: async () => ({
        ok: true,
        principal: { ...signedIn, actor: { id: 'profile-1', roles: ['account:acc-1'] } },
      }),
      toActor: () => ({ id: 'never' }),
    });
    expect((await withActor.resolve(req('Bearer t'))).id).toBe('profile-1');
    const mapped = poppyActorResolver({
      resource: 'https://app.example.com/mcp',
      authenticate: async () => ({ ok: true, principal: signedIn }),
      toActor: (principal) => ({ id: `profile-of-${principal.accountId}` }),
    });
    expect((await mapped.resolve(req('Bearer t'))).id).toBe('profile-of-acc-1');
  });

  it('answers a request with no token 401 with a bare challenge', async () => {
    const resolver = poppyActorResolver({
      authenticate: async () => ({ ok: true, principal: signedIn }),
    });
    const error = await Promise.resolve(resolver.resolve(req())).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(McpChallengeException);
    expect((error as McpChallengeException).getStatus()).toBe(401);
    expect((error as McpChallengeException).wwwAuthenticate()).toBe('Bearer');
  });
});

describe('McpChallengeException', () => {
  it('quotes its parameters and keeps a verifier’s own challenge', () => {
    expect(
      new McpChallengeException(403, {
        error: 'insufficient_scope',
        scope: 'a "b"',
      }).wwwAuthenticate(),
    ).toBe('Bearer error="insufficient_scope", scope="a \\"b\\""');
    expect(
      new McpChallengeException(401, { wwwAuthenticate: 'DPoP error="invalid_token"' })
        .withResourceMetadata('https://x/.well-known/oauth-protected-resource/mcp')
        .wwwAuthenticate(),
    ).toBe(
      'DPoP error="invalid_token", resource_metadata="https://x/.well-known/oauth-protected-resource/mcp"',
    );
  });
});
