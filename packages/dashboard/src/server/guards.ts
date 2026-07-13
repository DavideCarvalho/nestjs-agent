import 'reflect-metadata';
import type { CanActivate, Type } from '@nestjs/common';

/**
 * `@nestjs/common`'s own `GUARDS_METADATA` key, INLINED rather than deep-imported from
 * '@nestjs/common/constants' — that subpath has no extension and a strict ESM resolver (which the
 * built dual ESM/CJS output of this package is loaded under) 404s on it. Same convention as
 * `@dudousxd/nestjs-telescope`'s `telescope.module.ts` and `@dudousxd/nestjs-media`'s `guards.ts`.
 * A drift spec asserts this literal stays byte-identical to the real constant.
 */
export const GUARDS_METADATA = '__guards__';

/**
 * Narrows a `guards` entry to a class (constructor) as opposed to an already-instantiated
 * `CanActivate`. Only a class needs a DI provider so Nest can instantiate it — an instance is used
 * by the guards consumer as-is.
 */
export function isGuardClass(guard: Type<CanActivate> | CanActivate): guard is Type<CanActivate> {
  return typeof guard === 'function';
}

/**
 * Reads a controller's OWN `@UseGuards` metadata (not the inherited/prototype-chain one), or `[]`
 * when it carries none. MUST be called at module-load time — i.e. assigned to a top-level `const`
 * right after importing the controller — so it captures the pristine, decorator-defined baseline
 * BEFORE any `stampGuards` call below can mutate it.
 */
export function baseGuards(controller: Type): Array<Type<CanActivate> | CanActivate> {
  return Reflect.getOwnMetadata(GUARDS_METADATA, controller) ?? [];
}

/**
 * Stamp host guards onto a dashboard controller — ALWAYS recomputed as exactly
 * `[...base, ...(guards ?? [])]`, its captured `base` (the controller's own pristine `@UseGuards`
 * metadata, or `[]` when it has none), never appended onto whatever is CURRENTLY stamped on the
 * class. `AgentApiController`/`AgentUiController` are static classes reused across every
 * `forRoot`/`forRootAsync` call (unlike `@dudousxd/nestjs-telescope`'s `dynamicController`
 * subclass-per-call pattern), so this call is fully deterministic from `base` + the CURRENT call's
 * own `guards` — independent of whatever a prior call (in the same process, e.g. two tests in one
 * file) stamped, and never compounding across repeated calls.
 *
 * Omitting `guards` resets the controller to exactly `base` — the built-in gate alone (a no-op
 * when `dashboardAuth` is also unconfigured), reproducing today's behavior byte-for-byte.
 */
export function stampGuards(
  guards: Array<Type<CanActivate> | CanActivate> | undefined,
  entries: Array<[controller: Type, base: Array<Type<CanActivate> | CanActivate>]>,
): void {
  for (const [controller, base] of entries) {
    Reflect.defineMetadata(GUARDS_METADATA, [...base, ...(guards ?? [])], controller);
  }
}
