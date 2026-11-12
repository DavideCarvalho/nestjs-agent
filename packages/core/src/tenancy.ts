// The agent's tenancy, built on the local reader for the @dudousxd/nestjs-context tenancy contract
// (`./tenancy-reader.ts`, a verbatim copy of the context's). It imports nothing from the context, so
// the agent works with any context version, or with none at all: a missing or older accessor reads
// as `{ enabled: false }` and behaviour is unchanged.

import {
  type Tenancy as ReaderTenancy,
  type TenancyOption as ReaderTenancyOption,
  type TenantFilter,
  type TenantLevel,
  type TenantRef,
  readTenancy as readContextTenancy,
  tenantLabels as readTenantLabels,
} from './tenancy-reader.js';
import type { Actor } from './types.js';

/** One level of the request's tenant chain (clinic → unit), as the context reports it. */
export type ContextTenantLevel = TenantLevel;

/**
 * The tenant the request runs in, as the context reports it. `chain` (context 2.1+) is the active
 * path, root first, with this tenant last; `family` names a secondary tenant.
 */
export type ContextTenantRef = TenantRef;

/**
 * How data must be scoped right now. See the context "Tenancy" docs. With `kinds`, `tenant` is the
 * matching level of the chain (context 2.1+), and `chain` the path down to it.
 */
export type ContextTenantFilter = TenantFilter;

/**
 * The `tenancy` option of `AgentModule.forRoot`.
 *
 * - `'inherit'` (default): follow `ContextModule`'s `tenancy.enabled`, which is off by default.
 * - `false`: never scope by tenant.
 * - an object:
 *   - `enabled`: `'inherit'` or a boolean;
 *   - `kinds`: the level of the tenant chain the agent scopes by (`['clinic']` from a unit request
 *     stamps and reads the clinic);
 *   - `family`: scope by a secondary tenant instead of the primary one;
 *   - `required`: with no tenant, a tenant-scoped read or write throws the context's
 *     `TenantRequiredError` (403). Defaults to the context's `tenancy.required`;
 *   - `nullRows`: `'tenantless'` by default; `'shared'` also shows rows with no tenant to every
 *     tenant.
 */
export type TenancyOption = ReaderTenancyOption;

export type Tenancy = ReaderTenancy;

/** The `CONTEXT_ACCESSOR` token `@dudousxd/nestjs-context` binds. Inject it with `@Optional()`. */
export const CONTEXT_ACCESSOR = Symbol.for('@dudousxd/nestjs-context:accessor');

/** Per-call overrides of the option {@link readTenancy} reads. */
export interface ReadTenancyOverrides {
  /**
   * `false` for work outside a request (a worker, a durable turn, a schedule, the proposal worker,
   * usage recording): a missing tenant runs tenantless instead of throwing.
   */
  required?: boolean;
}

/**
 * The agent's tenancy for one operation. `accessor`: the `CONTEXT_ACCESSOR` injected with
 * `@Optional()`, if any. Call per operation: the context's switch can be flipped at any time.
 */
export function readTenancy(
  option: TenancyOption = 'inherit',
  accessor?: unknown,
  overrides: ReadTenancyOverrides = {},
): Tenancy {
  if (option === false || overrides.required === undefined) {
    return readContextTenancy(option, accessor ?? undefined);
  }
  const own = typeof option === 'object' ? option : {};
  return readContextTenancy({ ...own, required: overrides.required }, accessor ?? undefined);
}

/**
 * Labels for the console's Organization display, keyed by tenant id: the app's `tenancy.label`
 * (context 2.1+), else the slug, else the id. Never throws.
 */
export function tenantLabels(
  tenants: ContextTenantLevel[],
  accessor?: unknown,
): Promise<Record<string, string>> {
  return readTenantLabels(tenants, accessor ?? undefined);
}

/**
 * Which rows a read may see, by their nullable tenant column, as a store expresses it in a `WHERE`:
 * `tenant` set → rows of that tenant, plus rows with no tenant when `nulls`; `tenant` absent → only
 * rows with no tenant. No filter at all (tenancy off, `all`, `system`) is `undefined`.
 */
export interface TenantRowFilter {
  tenant?: string;
  nulls: boolean;
}

/**
 * The row filter for one read. With tenancy off, inside `Context.allTenants()` or outside any
 * request (`system`) it is `undefined`: nothing is filtered. Otherwise the tenant is `explicit` when
 * given (an `Actor.tenantRef` a resolver set wins), else the context tenant.
 */
export function tenantRowFilter(
  tenancy: Tenancy,
  explicit?: string | null,
): TenantRowFilter | undefined {
  if (!tenancy.enabled) return undefined;
  const filter = tenancy.filter();
  if (filter.mode === 'system' || filter.mode === 'all') return undefined;
  const tenant =
    typeof explicit === 'string' ? explicit : filter.mode === 'tenant' ? filter.tenant.id : null;
  if (tenant === null) return { nulls: true };
  return { tenant, nulls: tenancy.nullRows === 'shared' };
}

/** The matching rule: may a read under `filter` see a row whose tenant column holds `rowTenant`? */
export function tenantRowVisible(
  filter: TenantRowFilter | undefined,
  rowTenant: string | null | undefined,
): boolean {
  if (filter === undefined) return true;
  if (rowTenant === null || rowTenant === undefined) return filter.nulls;
  return filter.tenant !== undefined && filter.tenant === rowTenant;
}

/** The context tenant's id with tenancy on and a tenant in scope, else `undefined`. */
export function contextTenantRef(tenancy: Tenancy): string | undefined {
  if (!tenancy.enabled) return undefined;
  const filter = tenancy.filter();
  return filter.mode === 'tenant' ? filter.tenant.id : undefined;
}

/**
 * `actor` with `tenantRef` filled from the context tenant, when tenancy is on and the resolver left
 * it empty. A resolver that sets `tenantRef` wins; the same object comes back when nothing changes.
 */
export function withContextTenant<A extends Actor>(actor: A, tenancy: Tenancy): A {
  if (actor === null || typeof actor !== 'object') return actor;
  if (typeof actor.tenantRef === 'string' && actor.tenantRef !== '') return actor;
  const tenantRef = contextTenantRef(tenancy);
  return tenantRef === undefined ? actor : { ...actor, tenantRef };
}
