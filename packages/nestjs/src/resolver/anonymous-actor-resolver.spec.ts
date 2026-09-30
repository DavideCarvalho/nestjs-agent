import { UnauthorizedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { toolNameFromClass } from '../decorator/ai-tool.decorator.js';
import { AnonymousActorResolver } from './anonymous-actor-resolver.js';
import { requestUserActorResolver } from './request-user-actor-resolver.js';

function fakeRequest(cookie?: string, extra: Record<string, unknown> = {}) {
  const headers: Record<string, string> = {};
  const set: string[][] = [];
  return {
    req: {
      headers: { ...(cookie !== undefined ? { cookie } : {}) },
      res: {
        getHeader: (name: string) => (name === 'Set-Cookie' ? set.at(-1) : headers[name]),
        setHeader: (_name: string, value: string[]) => {
          set.push(value);
        },
      },
      ...extra,
    },
    set,
  };
}

describe('AnonymousActorResolver', () => {
  it('mints an HttpOnly cookie on first sight and derives the id from it, never exposing it', () => {
    const resolver = new AnonymousActorResolver();
    const { req, set } = fakeRequest();
    const actor = resolver.resolve(req);
    const cookie = set.at(-1)?.[0] ?? '';
    const token = /^agent_anon=([^;]+)/.exec(cookie)?.[1] ?? '';
    expect(cookie).toMatch(/HttpOnly/);
    expect(cookie).not.toMatch(/Secure/);
    expect(actor.id).toMatch(/^anon:/);
    expect(actor.id).not.toContain(token);
    expect(actor.roles).toEqual(['anonymous']);

    // The same browser, next request: same actor, no new cookie.
    const again = fakeRequest(`other=1; agent_anon=${token}`);
    expect(resolver.resolve(again.req).id).toBe(actor.id);
    expect(again.set).toHaveLength(0);
  });

  it('agrees with itself within one request, setting the cookie once', () => {
    const resolver = new AnonymousActorResolver();
    const { req, set } = fakeRequest();
    expect(resolver.resolve(req).id).toBe(resolver.resolve(req).id);
    expect(set).toHaveLength(1);
  });

  it('replaces a malformed token rather than trusting it', () => {
    const resolver = new AnonymousActorResolver();
    const { req, set } = fakeRequest('agent_anon=short');
    resolver.resolve(req);
    expect(set).toHaveLength(1);
  });

  it('marks the cookie Secure behind an HTTPS proxy, and for SameSite=None', () => {
    const behindProxy = fakeRequest(undefined, {});
    (behindProxy.req.headers as Record<string, string>)['x-forwarded-proto'] = 'https';
    new AnonymousActorResolver().resolve(behindProxy.req);
    expect(behindProxy.set[0]?.[0]).toMatch(/Secure/);

    const crossSite = fakeRequest();
    new AnonymousActorResolver({ sameSite: 'none' }).resolve(crossSite.req);
    expect(crossSite.set[0]?.[0]).toMatch(/SameSite=None; Secure/);
  });
});

describe('requestUserActorResolver', () => {
  it('maps req.user by default (id/sub, roles/role, tenant)', async () => {
    const resolver = requestUserActorResolver();
    expect(await resolver.resolve({ user: { sub: 7, role: 'ADMIN', tenantId: 't1' } })).toEqual({
      id: '7',
      roles: ['ADMIN'],
      tenantRef: 't1',
    });
  });

  it('refuses a request without req.user with 401', async () => {
    await expect(requestUserActorResolver().resolve({})).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
  });

  it('takes a mapper for another user shape', async () => {
    const resolver = requestUserActorResolver((user: { uuid: string }) => ({ id: user.uuid }));
    expect(await resolver.resolve({ user: { uuid: 'u-1' } })).toEqual({ id: 'u-1' });
  });
});

describe('toolNameFromClass', () => {
  it.each([
    ['GetWeatherTool', 'getWeather'],
    ['SQLQueryTool', 'sqlQuery'],
    ['Search', 'search'],
    ['Tool', 'tool'],
  ])('%s → %s', (name, expected) => {
    expect(toolNameFromClass(name)).toBe(expected);
  });
});
