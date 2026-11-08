import type { ToolCanRequirement } from './types.js';

/**
 * Where `@nestjs/authorization`'s `@Can()` files what it requires — its `CAN_METADATA`, which its
 * package does not export: `[{ policy, ability, args? }]` on the method or the class it decorates.
 */
const CAN_METADATA = 'authorization:can';

/**
 * Marks a `@Can()` arguments resolver whose arguments do not depend on the call — a role name, a
 * permission — so the agent can check it before offering the tool, as it does one with no
 * arguments. A shared `Symbol.for` key: any library (`@dudousxd/nestjs-authz`'s `roles()`) marks
 * its resolvers without depending on this one.
 */
export const STATIC_CAN_ARGS = Symbol.for('@dudousxd/static-can-args');

/**
 * A `@Can()` arguments resolver that always answers `args`, marked so the agent checks it before
 * offering the tool: `@Can(RolePolicy, 'has', staticCanArgs('admin'))`.
 */
export function staticCanArgs<const A extends readonly unknown[]>(...args: A): () => A {
  const resolver = () => args;
  Object.defineProperty(resolver, STATIC_CAN_ARGS, { value: args });
  return resolver;
}

/** One `@Can()` as `@nestjs/authorization` files it. */
interface CanEntry {
  policy: abstract new (...args: any[]) => unknown;
  ability: string;
  args?: unknown;
}

/** What a tool's `@Can()` decorators require, split by whether the agent can check it up front. */
export interface ToolCanDeclarations {
  /** No `args`: checked for the actor before the model is offered the tool, and on every call. */
  requirements: ToolCanRequirement[];
  /** With `args` (they read the call): only the method's guard can check them, on the call. */
  withArgs: number;
}

/** The `@Can()` decorators on any of `targets` (a class, a method), class-level ones first. */
export function readCanDeclarations(...targets: unknown[]): ToolCanDeclarations {
  const requirements: ToolCanRequirement[] = [];
  let withArgs = 0;
  for (const target of targets) {
    if (typeof target !== 'function') continue;
    const entries = (readMetadata(CAN_METADATA, target) as CanEntry[] | undefined) ?? [];
    for (const entry of entries) {
      const fixed =
        typeof entry.args === 'function'
          ? ((entry.args as { [STATIC_CAN_ARGS]?: readonly unknown[] })[STATIC_CAN_ARGS] ??
            undefined)
          : undefined;
      if (entry.args !== undefined && fixed === undefined) {
        withArgs += 1;
        continue;
      }
      const requirement: ToolCanRequirement = {
        policy: entry.policy,
        ability: entry.ability,
        ...(fixed !== undefined ? { args: fixed } : {}),
      };
      if (!requirements.some((had) => sameRequirement(had, requirement))) {
        requirements.push(requirement);
      }
    }
  }
  return { requirements, withArgs };
}

function sameRequirement(a: ToolCanRequirement, b: ToolCanRequirement): boolean {
  return (
    a.policy === b.policy &&
    a.ability === b.ability &&
    JSON.stringify(a.args ?? []) === JSON.stringify(b.args ?? [])
  );
}

/** `Reflect.getMetadata`, when `reflect-metadata` is loaded (it always is in a Nest app). */
function readMetadata(key: string, target: object): unknown {
  const reflect = Reflect as unknown as {
    getMetadata?: (key: string, target: object) => unknown;
  };
  return typeof reflect.getMetadata === 'function' ? reflect.getMetadata(key, target) : undefined;
}

/**
 * Where `@nestjs/authorization`'s `Can.Anyone()` marks a route (or method) open: its
 * `CAN_ANYONE_METADATA`, which its package does not export.
 */
const CAN_ANYONE_METADATA = 'authorization:can-anyone';

/**
 * `@nestjs/authorization`'s `Can.Anyone()`, without depending on it: marks a class or a method as
 * open to its global guard, which denies whatever declares no `@Can()` — a forgotten check must not
 * open a route. The library's own routes and the tools it governs carry it: who reaches them is the
 * agent's decision (the `actorResolver`, its `guards`, the roles policy, the tool's own `@Can()`),
 * and a `@Can()` declared on them is still checked, since the mark only opens what requires nothing.
 */
export function CanAnyone(): ClassDecorator & MethodDecorator {
  return ((target: object, _key?: string | symbol, descriptor?: PropertyDescriptor) => {
    markCanAnyone(descriptor !== undefined ? (descriptor.value as object) : target);
  }) as ClassDecorator & MethodDecorator;
}

/** {@link CanAnyone} on `target` itself (a class, or a method's function). */
export function markCanAnyone(target: object): void {
  const reflect = Reflect as unknown as {
    defineMetadata?: (key: string, value: unknown, target: object) => void;
  };
  reflect.defineMetadata?.(CAN_ANYONE_METADATA, true, target);
}

/**
 * The controllers a module mounts, with the `decorators` its user passed (`forRoot({ decorators })`)
 * applied — the ecosystem's convention, like `@nestjs/mcp`'s own `decorators` option: whoever mounts
 * a library's routes decides who reaches them, with the official tools
 * (`UseGuards(AuthenticationGuard)`, `@Can(ConsolePolicy, 'view')`, …).
 *
 * Each controller is subclassed for this registration and decorated there, so decorators passed to
 * one registration never stick to the shared class, nor to another registration in the same process.
 * Routes, injections and the library's own metadata are inherited from the class. No decorators →
 * the classes themselves.
 */
export function withControllerDecorators<T extends abstract new (...args: never[]) => unknown>(
  controllers: readonly T[],
  decorators: readonly ClassDecorator[] | undefined,
): T[] {
  if (decorators === undefined || decorators.length === 0) return [...controllers];
  return controllers.map((controller) => {
    const Base = controller as unknown as new (...args: unknown[]) => object;
    const Decorated = class extends Base {};
    Object.defineProperty(Decorated, 'name', { value: controller.name });
    // Nest reads some class metadata as the class's own (a constructor's `@Optional()` params):
    // the subclass starts with a copy of all of it, then the decorators add to that copy.
    const reflect = Reflect as unknown as {
      getOwnMetadataKeys?: (target: object) => unknown[];
      getOwnMetadata?: (key: unknown, target: object) => unknown;
      defineMetadata?: (key: unknown, value: unknown, target: object) => void;
    };
    for (const key of reflect.getOwnMetadataKeys?.(controller) ?? []) {
      reflect.defineMetadata?.(key, reflect.getOwnMetadata?.(key, controller), Decorated);
    }
    for (const decorator of decorators) decorator(Decorated);
    return Decorated as unknown as T;
  });
}
