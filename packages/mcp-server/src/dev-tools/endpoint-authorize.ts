import type { ExecutionContext, Type } from '@nestjs/common';
import { Logger } from '@nestjs/common';
import type { ModuleRef } from '@nestjs/core';

/*
 * `devTools.authorize`: the gate of the dev endpoint for libs that register WITHOUT a console gate of
 * their own. It takes every form a console's `authorize` takes, resolved the way the consoles resolve
 * it (the same contract as `@dudousxd/nestjs-agent-dashboard`'s, re-declared so this package does not
 * depend on the dashboard).
 */

/**
 * What an `authorize` check answers. An allow may name who it let in (`caller`, for example
 * `'user:42'`): the dev MCP endpoint logs it as the caller of a developer tool. Never put a secret
 * in it.
 */
export type ConsoleAuthorizeResult =
  | boolean
  | { allowed: true; caller?: string }
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
  | { allowed: true; caller?: string }
  | { allowed: false; reason: 'unauthenticated' | 'forbidden'; redirectTo?: string };

/** What a resolved `authorize` is: called once per request, never throws. */
export type ConsoleDecide = (context: ExecutionContext) => Promise<ConsoleDecision>;

/**
 * The provider that resolves gate names (`authorize: 'console.agent'`), bound globally by
 * `@dudousxd/nestjs-authz`'s `AuthzModule`. A registry symbol, so it is found without depending on
 * that package.
 */
export const CONSOLE_GATE = Symbol.for('@dudousxd/aviary:console-gate');
export interface ConsoleGate {
  allows(name: string, context: ExecutionContext): Promise<ConsoleAuthorizeResult>;
}

const MODULE = 'AgentMcpServerModule';
const logger = new Logger('AgentDevTools');

// Fresh objects on every call: a decision is never a shared, mutable singleton.
const allow = (caller?: string): ConsoleDecision =>
  caller !== undefined && caller !== '' ? { allowed: true, caller } : { allowed: true };
const forbidden = (): ConsoleDecision => ({ allowed: false, reason: 'forbidden' });
const unauthenticated = (): ConsoleDecision => ({ allowed: false, reason: 'unauthenticated' });

function isProduction(): boolean {
  return (process.env.NODE_ENV ?? '').trim().toLowerCase() === 'production';
}

/** Turns any {@link ConsoleAuthorizeResult} into a {@link ConsoleDecision}. */
export function normalizeConsoleResult(result: unknown): ConsoleDecision {
  if (result === true) return allow();
  if (result === null || typeof result !== 'object') return forbidden();
  const value = result as {
    allowed?: unknown;
    reason?: unknown;
    redirectTo?: unknown;
    caller?: unknown;
  };
  if (typeof value.redirectTo === 'string' && value.redirectTo !== '' && value.allowed !== true) {
    return { allowed: false, reason: 'unauthenticated', redirectTo: value.redirectTo };
  }
  if (value.allowed === true) {
    return allow(typeof value.caller === 'string' ? value.caller : undefined);
  }
  return value.reason === 'unauthenticated' ? unauthenticated() : forbidden();
}

/**
 * A class with `authorize()`: on the prototype, or (an instance-property arrow function,
 * `authorize = (ctx) => ...`) only on instances, so any `class`.
 */
function isAuthorizerClass(value: unknown): value is ConsoleAuthorizerClass {
  if (typeof value !== 'function') return false;
  if (
    typeof (value as { prototype?: { authorize?: unknown } }).prototype?.authorize === 'function'
  ) {
    return true;
  }
  return /^class[\s{]/.test(Function.prototype.toString.call(value));
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

/** `null`, `undefined` and `false` mean "nobody signed in", like `@nestjs/authorization`'s guard. */
function hasUser(user: unknown): boolean {
  return user !== null && user !== undefined && user !== false;
}

/** `{ policy, ability }`: `@nestjs/authorization` (an optional peer) imported lazily, checked at boot. */
async function policyDecider(
  check: ConsolePolicyCheck,
  moduleRef: ModuleRef,
): Promise<(context: ExecutionContext) => Promise<ConsoleDecision>> {
  let mod: typeof import('@nestjs/authorization');
  try {
    mod = await import('@nestjs/authorization');
  } catch {
    throw new Error(
      `${MODULE}: \`authorize: { policy, ability }\` needs @nestjs/authorization installed and AuthorizationModule imported; or pass a function, a class, or a gate name.`,
    );
  }
  const service = tryGet<{
    can(policy: Type<unknown>, ability: string, user: unknown): Promise<boolean>;
  }>(moduleRef, mod.AuthorizationService);
  if (service === undefined) {
    throw new Error(
      `${MODULE}: \`authorize: { policy, ability }\` needs AuthorizationModule.forRoot() from @nestjs/authorization imported in the app.`,
    );
  }
  const options = tryGet<{ getUser?: (context: ExecutionContext) => unknown }>(
    moduleRef,
    mod.AUTHORIZATION_MODULE_OPTIONS,
  );
  // The user the official `@Can()` sees: the module's `getUser` when one is configured, else the
  // package default (`request.user`). `undefined`, `null` and `false` all mean a guest.
  const getUser = (options?.getUser ?? mod.defaultGetUser) as (
    context: ExecutionContext,
  ) => unknown;
  return async (context) => {
    const user = await getUser(context);
    const signedIn = hasUser(user);
    if (await service.can(check.policy, check.ability, signedIn ? user : null)) return allow();
    return signedIn ? forbidden() : unauthenticated();
  };
}

/**
 * Resolves `authorize` into one function the guard calls per request. Configuration mistakes (a
 * gate name without nestjs-authz, a policy without `@nestjs/authorization`) throw here, so call it
 * at boot. The returned function never throws: an error is a `forbidden`.
 *
 * `authorize` omitted: open outside production, `forbidden` for every request in production (read
 * when this runs), and `missingWarning` logged when given.
 */
export async function resolveDevToolsAuthorize(
  authorize: ConsoleAuthorize | undefined,
  moduleRef: ModuleRef,
  options: { logger?: Logger; missingWarning?: string } = {},
): Promise<ConsoleDecide> {
  const log = options.logger ?? logger;
  if (authorize === undefined) {
    if (options.missingWarning !== undefined) log.warn(options.missingWarning);
    const production = isProduction();
    return async () => (production ? forbidden() : allow('dev-open'));
  }

  const instanceOf = classInstances(moduleRef);
  let decide: (context: ExecutionContext) => Promise<unknown>;
  if (typeof authorize === 'string') {
    const name = authorize;
    const gate = tryGet<ConsoleGate>(moduleRef, CONSOLE_GATE);
    if (gate === undefined) {
      throw new Error(
        `${MODULE}: \`authorize: '${name}'\` needs @dudousxd/nestjs-authz's AuthzModule (it resolves gate names); or pass a function, a class, or { policy, ability }.`,
      );
    }
    decide = (context) => gate.allows(name, context);
  } else if (isPolicyCheck(authorize)) {
    decide = await policyDecider(authorize, moduleRef);
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
      // A lazy import: remember the class, so the import runs once per registration.
      lazyClass = Class;
      return (await instanceOf(Class)).authorize(context);
    };
  } else {
    throw new Error(
      `${MODULE}: \`authorize\` must be a function, a class with authorize(), a lazy import, { policy, ability } or a gate name.`,
    );
  }

  return async (context) => {
    try {
      return normalizeConsoleResult(await decide(context));
    } catch (error) {
      log.warn(
        `console \`authorize\` threw, denying the request: ${error instanceof Error ? error.message : String(error)}`,
      );
      return forbidden();
    }
  };
}
