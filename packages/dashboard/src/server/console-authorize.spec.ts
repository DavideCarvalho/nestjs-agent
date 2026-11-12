import 'reflect-metadata';
import { AuthorizationModule, Policy } from '@nestjs/authorization';
import { type ExecutionContext, Global, Inject, Injectable, Logger, Module } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { Test } from '@nestjs/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  CONSOLE_AUTHORIZE_MISSING_WARNING,
  CONSOLE_GATE,
  type ConsoleAuthorize,
  type ConsoleAuthorizeResult,
  type ConsoleAuthorizer,
  authorizeByToken,
  normalizeConsoleResult,
  resolveConsoleAuthorize,
} from './console-authorize.js';

/** An HTTP execution context over a fake request. */
function httpContext(req: {
  headers?: Record<string, string>;
  user?: unknown;
  url?: string;
}): ExecutionContext {
  const request = { headers: {}, ...req };
  return {
    switchToHttp: () => ({ getRequest: () => request, getResponse: () => ({}) }),
    getType: () => 'http',
    getHandler: () => () => undefined,
    getClass: () => class {},
    getArgs: () => [request, {}],
    getArgByIndex: (i: number) => [request, {}][i],
  } as unknown as ExecutionContext;
}

const SECRET = Symbol('secret');

@Injectable()
class AdminOnly implements ConsoleAuthorizer {
  static instances = 0;
  constructor(@Inject(SECRET) private readonly secret: string) {
    AdminOnly.instances += 1;
  }
  authorize(context: ExecutionContext): ConsoleAuthorizeResult {
    const user = context.switchToHttp().getRequest<{ user?: { admin?: boolean } }>().user;
    return user?.admin === true && this.secret === 's3cret';
  }
}

@Global()
@Module({ providers: [{ provide: SECRET, useValue: 's3cret' }], exports: [SECRET] })
class SecretModule {}

async function moduleRefWith(...imports: unknown[]): Promise<ModuleRef> {
  const ref = await Test.createTestingModule({
    imports: [SecretModule, ...(imports as never[])],
  }).compile();
  await ref.init();
  return ref.get(ModuleRef);
}

afterEach(() => {
  vi.restoreAllMocks();
  AdminOnly.instances = 0;
});

describe('normalizeConsoleResult', () => {
  it.each([
    [true, { allowed: true }],
    [{ allowed: true }, { allowed: true }],
    [false, { allowed: false, reason: 'forbidden' }],
    [{ allowed: false }, { allowed: false, reason: 'forbidden' }],
    [
      { allowed: false, reason: 'forbidden' },
      { allowed: false, reason: 'forbidden' },
    ],
    [
      { allowed: false, reason: 'unauthenticated' },
      { allowed: false, reason: 'unauthenticated' },
    ],
    [{ redirectTo: '/login' }, { allowed: false, reason: 'unauthenticated', redirectTo: '/login' }],
    [undefined, { allowed: false, reason: 'forbidden' }],
    ['yes', { allowed: false, reason: 'forbidden' }],
  ])('%j → %j', (input, expected) => {
    expect(normalizeConsoleResult(input)).toEqual(expected);
  });
});

describe('resolveConsoleAuthorize', () => {
  it('inline function: gets the context and its result is normalized', async () => {
    const moduleRef = await moduleRefWith();
    const check = await resolveConsoleAuthorize(
      (ctx) => ctx.switchToHttp().getRequest<{ user?: { admin: boolean } }>().user?.admin === true,
      moduleRef,
    );
    expect(await check(httpContext({ user: { admin: true } }))).toEqual({ allowed: true });
    expect(await check(httpContext({}))).toEqual({ allowed: false, reason: 'forbidden' });
  });

  it('class form: created with DI, once per registration', async () => {
    const moduleRef = await moduleRefWith();
    const check = await resolveConsoleAuthorize(AdminOnly, moduleRef);
    expect(await check(httpContext({ user: { admin: true } }))).toEqual({ allowed: true });
    expect(await check(httpContext({ user: { admin: false } }))).toEqual({
      allowed: false,
      reason: 'forbidden',
    });
    expect(AdminOnly.instances).toBe(1);
  });

  it('class form: a registered provider is used as is', async () => {
    @Module({ providers: [AdminOnly], exports: [AdminOnly] })
    class AccessModule {}
    const moduleRef = await moduleRefWith(AccessModule);
    expect(AdminOnly.instances).toBe(1);
    const check = await resolveConsoleAuthorize(AdminOnly, moduleRef);
    expect(await check(httpContext({ user: { admin: true } }))).toEqual({ allowed: true });
    expect(AdminOnly.instances).toBe(1);
  });

  it('lazy import: the import runs once, the class is created with DI once', async () => {
    const moduleRef = await moduleRefWith();
    const load = vi.fn(async () => ({ default: AdminOnly }));
    const check = await resolveConsoleAuthorize(load, moduleRef);
    expect(await check(httpContext({ user: { admin: true } }))).toEqual({ allowed: true });
    expect(await check(httpContext({}))).toEqual({ allowed: false, reason: 'forbidden' });
    expect(load).toHaveBeenCalledTimes(1);
    expect(AdminOnly.instances).toBe(1);
  });

  it('every result shape', async () => {
    const moduleRef = await moduleRefWith();
    const cases: [ConsoleAuthorizeResult, unknown][] = [
      [{ allowed: true }, { allowed: true }],
      [
        { allowed: false, reason: 'unauthenticated' },
        { allowed: false, reason: 'unauthenticated' },
      ],
      [
        { redirectTo: '/login' },
        { allowed: false, reason: 'unauthenticated', redirectTo: '/login' },
      ],
    ];
    for (const [result, expected] of cases) {
      const check = await resolveConsoleAuthorize(async () => result, moduleRef);
      expect(await check(httpContext({}))).toEqual(expected);
    }
  });

  it('a throw is a denial, never an allow', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const moduleRef = await moduleRefWith();
    const check = await resolveConsoleAuthorize(() => {
      throw new Error('boom');
    }, moduleRef);
    expect(await check(httpContext({}))).toEqual({ allowed: false, reason: 'forbidden' });
    expect(warn).toHaveBeenCalledOnce();
  });

  describe('policy form ({ policy, ability }, @nestjs/authorization)', () => {
    @Policy()
    class ConsolePolicy {
      view(user: { roles: string[] } | null) {
        return user?.roles.includes('OPS') === true;
      }
    }

    it('allows, and denies as unauthenticated (no user) or forbidden (a user)', async () => {
      const moduleRef = await moduleRefWith(
        AuthorizationModule.forRoot({ policies: [ConsolePolicy], globalGuard: false }),
      );
      const check = await resolveConsoleAuthorize(
        { policy: ConsolePolicy, ability: 'view' },
        moduleRef,
      );
      expect(await check(httpContext({ user: { roles: ['OPS'] } }))).toEqual({ allowed: true });
      expect(await check(httpContext({ user: { roles: [] } }))).toEqual({
        allowed: false,
        reason: 'forbidden',
      });
      expect(await check(httpContext({}))).toEqual({ allowed: false, reason: 'unauthenticated' });
    });

    it("uses the module's getUser", async () => {
      const moduleRef = await moduleRefWith(
        AuthorizationModule.forRoot({
          policies: [ConsolePolicy],
          globalGuard: false,
          getUser: (ctx) => {
            const role = ctx.switchToHttp().getRequest<{ headers: Record<string, string> }>()
              .headers['x-role'];
            return role === undefined ? null : { roles: [role] };
          },
        }),
      );
      const check = await resolveConsoleAuthorize(
        { policy: ConsolePolicy, ability: 'view' },
        moduleRef,
      );
      expect(await check(httpContext({ headers: { 'x-role': 'OPS' } }))).toEqual({
        allowed: true,
      });
    });

    it('without AuthorizationModule, rejects at resolution (boot) with a tailored message', async () => {
      const moduleRef = await moduleRefWith();
      await expect(
        resolveConsoleAuthorize({ policy: ConsolePolicy, ability: 'view' }, moduleRef),
      ).rejects.toThrow(
        '`authorize: { policy, ability }` needs AuthorizationModule.forRoot() from @nestjs/authorization imported in the app',
      );
    });

    it('getUser: `null` and `false` are a guest; only `undefined` falls back to `request.user`', async () => {
      const answers: unknown[] = [];
      const moduleRef = await moduleRefWith(
        AuthorizationModule.forRoot({
          policies: [ConsolePolicy],
          globalGuard: false,
          getUser: () => answers.shift() as never,
        }),
      );
      const check = await resolveConsoleAuthorize(
        { policy: ConsolePolicy, ability: 'view' },
        moduleRef,
      );
      const ops = httpContext({ user: { roles: ['OPS'] } });
      const guest = { allowed: false, reason: 'unauthenticated' };
      answers.push(null);
      expect(await check(ops)).toEqual(guest);
      answers.push(false);
      expect(await check(ops)).toEqual(guest);
      answers.push(undefined);
      expect(await check(ops)).toEqual({ allowed: true });
    });
  });

  describe('gate name (string)', () => {
    it('asks the console-gate provider', async () => {
      const allows = vi.fn(async (name: string, ctx: ExecutionContext) => {
        const user = ctx.switchToHttp().getRequest<{ user?: string }>().user;
        return name === 'console.agent' && user === 'ana';
      });
      @Global()
      @Module({
        providers: [{ provide: CONSOLE_GATE, useValue: { allows } }],
        exports: [CONSOLE_GATE],
      })
      class FakeAuthzModule {}
      const moduleRef = await moduleRefWith(FakeAuthzModule);
      const check = await resolveConsoleAuthorize('console.agent', moduleRef);
      expect(await check(httpContext({ user: 'ana' }))).toEqual({ allowed: true });
      expect(await check(httpContext({ user: 'bob' }))).toEqual({
        allowed: false,
        reason: 'forbidden',
      });
      expect(allows).toHaveBeenCalledWith('console.agent', expect.anything());
    });

    it('without the provider, throws with a clear message', async () => {
      const moduleRef = await moduleRefWith();
      await expect(resolveConsoleAuthorize('console.agent', moduleRef)).rejects.toThrow(
        /`authorize: 'console.agent'` needs @dudousxd\/nestjs-authz's AuthzModule/,
      );
    });
  });

  it('rejects a value that is none of the forms', async () => {
    const moduleRef = await moduleRefWith();
    await expect(
      resolveConsoleAuthorize(42 as unknown as ConsoleAuthorize, moduleRef),
    ).rejects.toThrow(/`authorize` must be/);
  });
});

describe('resolveConsoleAuthorize — `authorize` omitted', () => {
  const previousEnv = process.env.NODE_ENV;
  afterEach(() => {
    process.env.NODE_ENV = previousEnv;
  });

  it('open outside production, forbidden in production, and one warning each time', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const moduleRef = await moduleRefWith();
    process.env.NODE_ENV = 'development';
    const dev = await resolveConsoleAuthorize(undefined, moduleRef);
    expect(await dev(httpContext({}))).toEqual({ allowed: true });
    process.env.NODE_ENV = 'production';
    const prod = await resolveConsoleAuthorize(undefined, moduleRef);
    expect(await prod(httpContext({}))).toEqual({ allowed: false, reason: 'forbidden' });
    expect(warn.mock.calls.map(([m]) => m)).toEqual([
      CONSOLE_AUTHORIZE_MISSING_WARNING,
      CONSOLE_AUTHORIZE_MISSING_WARNING,
    ]);
    await resolveConsoleAuthorize(undefined, moduleRef, { warnIfMissing: false });
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('the warning text', () => {
    expect(CONSOLE_AUTHORIZE_MISSING_WARNING).toBe(
      '[@dudousxd/nestjs-agent-dashboard] console has no `authorize` configured: it is open outside production and denies every request in production. Set `authorize` in AgentDashboardModule.forRoot().',
    );
  });
});

describe('denials are fresh objects', () => {
  it('no shared singleton is returned by reference', async () => {
    const moduleRef = await moduleRefWith();
    const deny = await resolveConsoleAuthorize(() => false, moduleRef);
    const first = await deny(httpContext({}));
    const second = await deny(httpContext({}));
    expect(first).toEqual(second);
    expect(first).not.toBe(second);
    expect(normalizeConsoleResult({ allowed: false, reason: 'unauthenticated' })).not.toBe(
      normalizeConsoleResult({ allowed: false, reason: 'unauthenticated' }),
    );
    expect(normalizeConsoleResult(true)).not.toBe(normalizeConsoleResult(true));
  });
});

describe('authorizeByToken', () => {
  const byToken = authorizeByToken({ token: 'tok-123' });

  it('allows a matching Bearer token', () => {
    expect(byToken(httpContext({ headers: { authorization: 'Bearer tok-123' } }))).toBe(true);
  });

  it('a wrong token, or none, is unauthenticated', () => {
    const denied = { allowed: false, reason: 'unauthenticated' };
    expect(byToken(httpContext({ headers: { authorization: 'Bearer nope' } }))).toEqual(denied);
    expect(byToken(httpContext({ headers: { authorization: 'Basic tok-123' } }))).toEqual(denied);
    expect(byToken(httpContext({}))).toEqual(denied);
  });

  it('ignores ?token= and other headers', () => {
    const denied = { allowed: false, reason: 'unauthenticated' };
    expect(byToken(httpContext({ url: '/ai-gateway/api/spend?token=tok-123' }))).toEqual(denied);
    expect(byToken(httpContext({ headers: { 'x-console-token': 'tok-123' } }))).toEqual(denied);
  });

  it('throws on an empty token, at config time', () => {
    expect(() => authorizeByToken({ token: '' })).toThrow(/empty/);
    expect(() => authorizeByToken({ token: undefined })).toThrow(/empty/);
  });
});
