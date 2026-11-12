import { createHash, timingSafeEqual } from 'node:crypto';
import { type ExecutionContext, Logger, type Type } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';

/** What an `authorize` check answers. */
export type ConsoleAuthorizeResult =
  | boolean
  | { allowed: true }
  | { allowed: false; reason?: 'unauthenticated' | 'forbidden' }
  | { redirectTo: string };

/** Class form: an @Injectable() provider (constructor injection works). */
export interface ConsoleAuthorizer {
  authorize(context: ExecutionContext): ConsoleAuthorizeResult | Promise<ConsoleAuthorizeResult>;
}
export type ConsoleAuthorizerClass = Type<ConsoleAuthorizer>;

/** @nestjs/authorization policy check: policy[ability](user). */
export interface ConsolePolicyCheck {
  policy: Type<unknown>;
  ability: string;
}

/** Who reaches the console. */
export type ConsoleAuthorize =
  | ((context: ExecutionContext) => ConsoleAuthorizeResult | Promise<ConsoleAuthorizeResult>) // inline
  | ConsoleAuthorizerClass // class
  | (() => Promise<{ default: ConsoleAuthorizerClass }>) // lazy import
  | ConsolePolicyCheck // official policy
  | string; // registered gate name

/** A normalized `authorize` answer. */
export type ConsoleDecision =
  | { allowed: true }
  | { allowed: false; reason: 'unauthenticated' | 'forbidden'; redirectTo?: string };

/** The resolved check: never throws; a throw inside `authorize` is a `forbidden`. */
export type ConsoleAccessCheck = ((context: ExecutionContext) => Promise<ConsoleDecision>) & {
  /** Settles once boot-time requirements are met; rejects with a clear message when they are not. */
  readonly ready: Promise<void>;
};

/**
 * The provider that resolves gate names (`authorize: 'console.agent'`), bound globally by
 * `@dudousxd/nestjs-authz`'s `AuthzModule`.
 */
export const CONSOLE_GATE = Symbol.for('@dudousxd/aviary:console-gate');

interface ConsoleGate {
  allows(name: string, context: ExecutionContext): Promise<ConsoleAuthorizeResult>;
}

const logger = new Logger('AgentDashboardModule');

const ALLOW: ConsoleDecision = { allowed: true };
const FORBID: ConsoleDecision = { allowed: false, reason: 'forbidden' };

/** Normalize any {@link ConsoleAuthorizeResult} into a {@link ConsoleDecision}. */
export function normalizeConsoleDecision(result: unknown): ConsoleDecision {
  if (result === true) return ALLOW;
  if (result === null || typeof result !== 'object') return FORBID;
  const value = result as { allowed?: unknown; reason?: unknown; redirectTo?: unknown };
  if (typeof value.redirectTo === 'string' && value.redirectTo !== '') {
    return { allowed: false, reason: 'unauthenticated', redirectTo: value.redirectTo };
  }
  if (value.allowed === true) return ALLOW;
  if (value.allowed === false && value.reason === 'unauthenticated') {
    return { allowed: false, reason: 'unauthenticated' };
  }
  return FORBID;
}

function isAuthorizerClass(value: unknown): value is ConsoleAuthorizerClass {
  return (
    typeof value === 'function' &&
    typeof (value as { prototype?: { authorize?: unknown } }).prototype?.authorize === 'function'
  );
}

function isPolicyCheck(value: unknown): value is ConsolePolicyCheck {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as ConsolePolicyCheck).policy === 'function' &&
    typeof (value as ConsolePolicyCheck).ability === 'string'
  );
}

function lazyModuleClass(value: unknown): ConsoleAuthorizerClass | undefined {
  if (typeof value !== 'object' || value === null) return undefined;
  const candidate = (value as { default?: unknown }).default;
  return isAuthorizerClass(candidate) ? candidate : undefined;
}

/** A provider registered anywhere (`strict: false`), or `undefined`. */
function tryGet<T>(moduleRef: ModuleRef, token: unknown): T | undefined {
  try {
    return (moduleRef.get(token as never, { strict: false }) as T | undefined) ?? undefined;
  } catch {
    return undefined;
  }
}

/** One instance per class per registration: a registered provider, else created with DI. */
function classInstances(moduleRef: ModuleRef) {
  const instances = new Map<ConsoleAuthorizerClass, Promise<ConsoleAuthorizer>>();
  return (Class: ConsoleAuthorizerClass): Promise<ConsoleAuthorizer> => {
    let instance = instances.get(Class);
    if (instance === undefined) {
      const registered = tryGet<ConsoleAuthorizer>(moduleRef, Class);
      instance = registered !== undefined ? Promise.resolve(registered) : moduleRef.create(Class);
      // A failed create is retried on the next request, not cached as a permanent denial.
      instance.catch(() => instances.delete(Class));
      instances.set(Class, instance);
    }
    return instance;
  };
}

/** `@nestjs/authorization`'s service + `getUser`, imported lazily (an optional peer). */
async function loadPolicyChecker(moduleRef: ModuleRef): Promise<{
  can(policy: Type<unknown>, ability: string, user: unknown): Promise<boolean>;
  getUser(context: ExecutionContext): unknown;
}> {
  let mod: typeof import('@nestjs/authorization');
  try {
    mod = await import('@nestjs/authorization');
  } catch {
    throw new Error(
      'AgentDashboardModule: `authorize: { policy, ability }` needs `@nestjs/authorization` installed ' +
        '(and its AuthorizationModule imported); or pass a function, a class, or a gate name.',
    );
  }
  const service = tryGet<{
    can(policy: Type<unknown>, ability: string, user: unknown): Promise<boolean>;
  }>(moduleRef, mod.AuthorizationService);
  if (service === undefined) {
    throw new Error(
      'AgentDashboardModule: `authorize: { policy, ability }` needs `@nestjs/authorization`’s ' +
        'AuthorizationModule imported in the app; or pass a function, a class, or a gate name.',
    );
  }
  const options = tryGet<{ getUser?: (context: ExecutionContext) => unknown }>(
    moduleRef,
    mod.AUTHORIZATION_MODULE_OPTIONS,
  );
  const getUser = options?.getUser ?? mod.defaultGetUser;
  return {
    can: (policy, ability, user) => service.can(policy as never, ability as never, user as never),
    getUser,
  };
}

/**
 * Turn any {@link ConsoleAuthorize} form into one check. Requirements are validated when the
 * returned check's `ready` settles (the module awaits it at init, so a missing `AuthzModule` or
 * `@nestjs/authorization` fails the boot); the check itself never throws.
 */
export function resolveConsoleAuthorize(
  authorize: ConsoleAuthorize,
  moduleRef: ModuleRef,
): ConsoleAccessCheck {
  const instanceOf = classInstances(moduleRef);
  let decide: (context: ExecutionContext) => Promise<unknown>;
  let ready: Promise<void> = Promise.resolve();

  if (typeof authorize === 'string') {
    const name = authorize;
    const gate = tryGet<ConsoleGate>(moduleRef, CONSOLE_GATE);
    if (gate === undefined) {
      throw new Error(
        `AgentDashboardModule: \`authorize: '${name}'\` needs @dudousxd/nestjs-authz's AuthzModule (it resolves gate names); or pass a function, a class, or { policy, ability }.`,
      );
    }
    decide = (context) => gate.allows(name, context);
  } else if (isPolicyCheck(authorize)) {
    const { policy, ability } = authorize;
    const checker = loadPolicyChecker(moduleRef);
    ready = checker.then(() => undefined);
    decide = async (context) => {
      const { can, getUser } = await checker;
      const user = await getUser(context);
      if (await can(policy, ability, user)) return true;
      const guest = user === null || user === undefined || user === false;
      return { allowed: false, reason: guest ? 'unauthenticated' : 'forbidden' } as const;
    };
  } else if (isAuthorizerClass(authorize)) {
    const Class = authorize;
    decide = async (context) => (await instanceOf(Class)).authorize(context);
  } else if (typeof authorize === 'function') {
    const fn = authorize as (context: ExecutionContext) => unknown;
    let lazyClass: ConsoleAuthorizerClass | undefined;
    decide = async (context) => {
      if (lazyClass !== undefined) return (await instanceOf(lazyClass)).authorize(context);
      const result = await fn(context);
      const Class = lazyModuleClass(result);
      if (Class === undefined) return result;
      lazyClass = Class;
      return (await instanceOf(Class)).authorize(context);
    };
  } else {
    throw new Error(
      'AgentDashboardModule: `authorize` must be a function, a ConsoleAuthorizer class, a lazy ' +
        "import (`() => import('./access.js')`), `{ policy, ability }`, or a gate name.",
    );
  }

  // Marked handled once: a direct caller that never awaits `ready` gets no unhandled rejection,
  // and the per-request path still denies (the throw below becomes a `forbidden`).
  ready.catch(() => undefined);
  const check = async (context: ExecutionContext): Promise<ConsoleDecision> => {
    try {
      return normalizeConsoleDecision(await decide(context));
    } catch (error) {
      logger.warn(
        `console \`authorize\` threw, denying the request: ${error instanceof Error ? error.message : String(error)}`,
      );
      return FORBID;
    }
  };
  return Object.assign(check, { ready });
}

/** The check used when `authorize` is omitted: open outside production, denied in production. */
export function defaultConsoleAccess(production: boolean): ConsoleAccessCheck {
  const decision = production ? FORBID : ALLOW;
  return Object.assign(async () => decision, { ready: Promise.resolve() });
}

/** The one boot warning for an omitted `authorize`. */
export const CONSOLE_AUTHORIZE_MISSING_WARNING =
  '[@dudousxd/nestjs-agent-dashboard] console has no `authorize` configured: it is open outside ' +
  'production and denies every request in production. Set `authorize` in AgentDashboardModule.forRoot().';

function sha256(value: string): Buffer {
  return createHash('sha256').update(value).digest();
}

/**
 * `authorize` by a bearer token: allows when `Authorization: Bearer <token>` matches (compared in
 * constant time), else `unauthenticated`. Header only. An empty token throws here, at config time.
 */
export function authorizeByToken(options: { token: string | undefined }): (
  context: ExecutionContext,
) => ConsoleAuthorizeResult {
  const token = options.token;
  if (typeof token !== 'string' || token === '') {
    throw new Error('authorizeByToken: `token` is empty; set it (e.g. from an env var).');
  }
  const expected = sha256(token);
  return (context) => {
    const req = context
      .switchToHttp()
      .getRequest<{ headers?: Record<string, string | string[] | undefined> }>();
    const header = req?.headers?.authorization;
    const value = Array.isArray(header) ? header[0] : header;
    const match = typeof value === 'string' ? /^Bearer\s+(.+)$/i.exec(value.trim()) : null;
    if (match?.[1] !== undefined && timingSafeEqual(sha256(match[1]), expected)) return true;
    return { allowed: false, reason: 'unauthenticated' };
  };
}
