// Local reader for the @dudousxd/nestjs-context tenancy contract. It imports nothing from the
// context, so the agent works with any context version, or with none at all: a missing or older
// accessor reads as `{ enabled: false }` and behaviour is unchanged.

import type { Actor } from './types.js';

/** The tenant the request runs in, as the context reports it. */
export interface ContextTenantRef {
  id: string;
  kind: string;
  source: string;
  slug?: string;
  role?: string;
}

/** How data must be scoped right now. See the context "Tenancy" docs. */
export type ContextTenantFilter =
  | { mode: 'system' }
  | { mode: 'all' }
  | { mode: 'tenantless' }
  | { mode: 'tenant'; tenant: ContextTenantRef };

/**
 * The `tenancy` option of `AgentModule.forRoot`.
 *
 * - `'inherit'` (default): follow `ContextModule`'s `tenancy.enabled`, which is off by default.
 * - `false`: never scope by tenant.
 * - an object: `enabled` (`'inherit'` or a boolean), the agent's own `kinds` allow-list, and
 *   `nullRows` (`'tenantless'` by default; `'shared'` also shows rows with no tenant to every tenant).
 */
export type TenancyOption =
  | 'inherit'
  | false
  | { enabled?: 'inherit' | boolean; kinds?: string[]; nullRows?: 'tenantless' | 'shared' };

export type Tenancy =
  | { enabled: false }
  | { enabled: true; nullRows: 'tenantless' | 'shared'; filter(): ContextTenantFilter };

/** The `CONTEXT_ACCESSOR` token `@dudousxd/nestjs-context` binds. Inject it with `@Optional()`. */
export const CONTEXT_ACCESSOR = Symbol.for('@dudousxd/nestjs-context:accessor');

interface Accessor {
  tenancy?(): { enabled: boolean; kinds?: string[] };
  tenantFilter?(options?: { kinds?: string[] }): ContextTenantFilter;
}
const SLOT = Symbol.for('@dudousxd/nestjs-diagnostics:accessor');

/** `accessor`: the `CONTEXT_ACCESSOR` injected with `@Optional()`, if any. Call per operation. */
export function readTenancy(option: TenancyOption = 'inherit', accessor?: unknown): Tenancy {
  const slot = (globalThis as unknown as Record<symbol, { current?: unknown } | undefined>)[SLOT];
  const a = (accessor ?? slot?.current) as Accessor | null | undefined;
  if (option === false || typeof a?.tenancy !== 'function' || !a.tenantFilter) {
    return { enabled: false };
  }
  const tenantFilter = a.tenantFilter.bind(a);
  const own = typeof option === 'object' ? option : {};
  const inherit = own.enabled === undefined || own.enabled === 'inherit';
  if (!(inherit ? a.tenancy().enabled : own.enabled)) return { enabled: false };
  const kinds = own.kinds;
  return {
    enabled: true,
    nullRows: own.nullRows ?? 'tenantless',
    filter: () => tenantFilter(kinds ? { kinds } : undefined),
  };
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
