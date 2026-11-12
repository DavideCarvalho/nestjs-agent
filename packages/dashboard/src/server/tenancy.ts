// Local reader for the @dudousxd/nestjs-context tenancy contract (the dashboard keeps its own, like
// its tokens, so it never value-imports core). A missing or older context reads as tenancy off.
import type { TenantRowFilter } from '@dudousxd/nestjs-agent-core';

type TenantFilter =
  | { mode: 'system' }
  | { mode: 'all' }
  | { mode: 'tenantless' }
  | { mode: 'tenant'; tenant: { id: string } };

/** The agent's `tenancy` option, as `AgentModule.forRoot({ tenancy })` holds it. */
export type AgentTenancyOption =
  | 'inherit'
  | false
  | { enabled?: 'inherit' | boolean; kinds?: string[]; nullRows?: 'tenantless' | 'shared' };

interface Accessor {
  tenancy?(): { enabled: boolean; kinds?: string[] };
  tenantFilter?(options?: { kinds?: string[] }): TenantFilter;
}
const SLOT = Symbol.for('@dudousxd/nestjs-diagnostics:accessor');

/**
 * The rows the console may show right now, by the viewer's context tenant: `undefined` (every row)
 * with tenancy off, inside `Context.allTenants()` or with no request context.
 */
export function consoleTenantFilter(
  option: AgentTenancyOption = 'inherit',
  accessor?: unknown,
): TenantRowFilter | undefined {
  const slot = (globalThis as unknown as Record<symbol, { current?: unknown } | undefined>)[SLOT];
  const a = (accessor ?? slot?.current) as Accessor | null | undefined;
  if (option === false || typeof a?.tenancy !== 'function' || !a.tenantFilter) return undefined;
  const own = typeof option === 'object' ? option : {};
  const inherit = own.enabled === undefined || own.enabled === 'inherit';
  if (!(inherit ? a.tenancy().enabled : own.enabled)) return undefined;
  const filter = a.tenantFilter(own.kinds ? { kinds: own.kinds } : undefined);
  if (filter.mode === 'system' || filter.mode === 'all') return undefined;
  if (filter.mode === 'tenantless') return { nulls: true };
  return { tenant: filter.tenant.id, nulls: own.nullRows === 'shared' };
}
