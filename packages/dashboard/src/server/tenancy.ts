// The console's tenancy, on its own copy of the @dudousxd/nestjs-context reader
// (`./tenancy-reader.ts`, verbatim; the dashboard never value-imports core). A missing or older
// context reads as tenancy off.
import type { TenantRowFilter } from '@dudousxd/nestjs-agent-core';
import {
  type TenancyOption,
  type TenantLevel,
  readTenancy,
  tenantLabels,
} from './tenancy-reader.js';

/** The agent's `tenancy` option, as `AgentModule.forRoot({ tenancy })` holds it. */
export type AgentTenancyOption = TenancyOption;

/**
 * The rows the console may show right now, by the viewer's context tenant: `undefined` (every row)
 * with tenancy off, inside `Context.allTenants()` or with no request context. With `kinds`, the
 * tenant is the matching level of the viewer's chain. With a tenant `required` and none in scope it
 * throws the context's `TenantRequiredError` (403).
 */
export function consoleTenantFilter(
  option: AgentTenancyOption = 'inherit',
  accessor?: unknown,
): TenantRowFilter | undefined {
  const tenancy = readTenancy(option, accessor ?? undefined);
  if (!tenancy.enabled) return undefined;
  const filter = tenancy.filter();
  if (filter.mode === 'system' || filter.mode === 'all') return undefined;
  if (filter.mode === 'tenantless') return { nulls: true };
  return { tenant: filter.tenant.id, nulls: tenancy.nullRows === 'shared' };
}

/** One level of the viewer's Organization, labelled. */
export interface ConsoleTenantLevel {
  id: string;
  kind: string;
  label: string;
}

/** `GET <api>/tenancy`: the Organization the console is scoped to, for the header chip. */
export interface ConsoleTenancy {
  /** Whether the agent's tenancy is on. */
  enabled: boolean;
  /**
   * `tenant`: scoped to `tenant`. `tenantless`: rows with no tenant only. `all`: every tenant
   * (`Context.allTenants()`, or no request context).
   */
  scope: 'tenant' | 'tenantless' | 'all';
  /** The level the console is scoped to (the `kinds` match), labelled. `null` unless `tenant`. */
  tenant: ConsoleTenantLevel | null;
  /** The path down to `tenant`, root first, labelled (`[tenant]` for a flat tenant). */
  chain: ConsoleTenantLevel[];
}

/**
 * The viewer's Organization, labelled through the app's `tenancy.label` (context 2.1+), else slug,
 * else id. Never throws: a `required` tenant that is missing reads as `tenantless`.
 */
export async function consoleTenancy(
  option: AgentTenancyOption = 'inherit',
  accessor?: unknown,
): Promise<ConsoleTenancy> {
  const lenient = option === false ? false : { ...(typeof option === 'object' ? option : {}) };
  if (lenient !== false) lenient.required = false;
  const tenancy = readTenancy(lenient, accessor ?? undefined);
  if (!tenancy.enabled) return { enabled: false, scope: 'all', tenant: null, chain: [] };
  let filter: ReturnType<typeof tenancy.filter>;
  try {
    filter = tenancy.filter();
  } catch {
    return { enabled: true, scope: 'tenantless', tenant: null, chain: [] };
  }
  if (filter.mode === 'system' || filter.mode === 'all') {
    return { enabled: true, scope: 'all', tenant: null, chain: [] };
  }
  if (filter.mode === 'tenantless') {
    return { enabled: true, scope: 'tenantless', tenant: null, chain: [] };
  }
  const levels: TenantLevel[] =
    Array.isArray(filter.chain) && filter.chain.length > 0 ? filter.chain : [filter.tenant];
  const labels = await tenantLabels(levels, accessor ?? undefined);
  const labelled = (level: TenantLevel): ConsoleTenantLevel => {
    const label = labels[level.id];
    return {
      id: level.id,
      kind: level.kind,
      label: typeof label === 'string' && label !== '' ? label : level.id,
    };
  };
  return {
    enabled: true,
    scope: 'tenant',
    tenant: labelled(filter.tenant),
    chain: levels.map(labelled),
  };
}
