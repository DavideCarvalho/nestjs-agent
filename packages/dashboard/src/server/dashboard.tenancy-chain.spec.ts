import type { AgentGovernanceQueries, TenantRowFilter } from '@dudousxd/nestjs-agent-core';
import { ForbiddenException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { DashboardService } from './dashboard.service.js';

/** The context's `TenantRequiredError`: a 403 with `code: 'E_TENANT_REQUIRED'`. */
class TenantRequiredError extends ForbiddenException {
  readonly code = 'E_TENANT_REQUIRED';
}

interface Level {
  id: string;
  kind: string;
  slug?: string;
}

/** The index of the most specific level whose kind is listed, else -1. */
function lastIndexOfKind(chain: Level[], kinds: string[] | undefined): number {
  for (let i = chain.length - 1; i >= 0; i--) {
    if (kinds?.includes((chain[i] as Level).kind)) return i;
  }
  return -1;
}

/** A structural accessor that behaves like `@dudousxd/nestjs-context` 2.1. */
function context21(
  chain: Level[] | null | 'all',
  options: {
    required?: boolean;
    labels?: (tenants: Level[]) => Promise<Record<string, string>>;
  } = {},
) {
  return {
    tenancy: () => ({ enabled: true, required: options.required ?? false }),
    tenantFilter(filter?: { kinds?: string[]; required?: boolean }) {
      if (chain === 'all') return { mode: 'all' as const };
      const matched =
        chain === null
          ? -1
          : filter?.kinds === undefined
            ? chain.length - 1
            : lastIndexOfKind(chain, filter.kinds);
      if (chain === null || matched < 0) {
        if (filter?.required ?? options.required) throw new TenantRequiredError('tenant required');
        return { mode: 'tenantless' as const };
      }
      return {
        mode: 'tenant' as const,
        tenant: { ...(chain[matched] as Level), source: 'app' },
        chain: chain.slice(0, matched + 1),
      };
    },
    ...(options.labels ? { tenantLabels: options.labels } : {}),
  };
}

/** Governance queries that answer empty and record which tenant view each read went through. */
function queries() {
  const reads: (TenantRowFilter | null)[] = [];
  const view = (filter: TenantRowFilter | null): AgentGovernanceQueries =>
    new Proxy({} as AgentGovernanceQueries, {
      get(_target, name) {
        if (name === 'forTenant')
          return filter === null ? (next: TenantRowFilter) => view(next) : undefined;
        if (name === 'then') return undefined;
        return async () => {
          reads.push(filter);
          if (name === 'runDetail' || name === 'threadDetail') return null;
          return String(name).endsWith('Page') ? { rows: [], total: 0, page: 1, pageSize: 10 } : [];
        };
      },
    });
  return { reads, root: view(null) };
}

const dashboard = (q: ReturnType<typeof queries>, tenancy: unknown, accessor: unknown) =>
  new DashboardService(
    q.root,
    undefined,
    undefined,
    undefined,
    { tenancy: tenancy as never },
    accessor,
  );

const C1 = { id: 'C1', kind: 'clinic', slug: 'clinic-one' };
const U1 = { id: 'U1', kind: 'unit' };

describe('the console on a nested tenant', () => {
  it("scopes by the configured level of the viewer's chain", async () => {
    const q = queries();
    await dashboard(q, { kinds: ['clinic'] }, context21([C1, U1])).recentThreads(10);
    await dashboard(q, 'inherit', context21([C1, U1])).recentThreads(10);
    expect(q.reads).toEqual([
      { tenant: 'C1', nulls: false },
      { tenant: 'U1', nulls: false },
    ]);
  });

  it('required: a viewer with no tenant gets 403; the search finds nothing instead', async () => {
    const q = queries();
    const service = dashboard(q, 'inherit', context21(null, { required: true }));
    await expect(service.recentThreads(10)).rejects.toMatchObject({
      status: 403,
      code: 'E_TENANT_REQUIRED',
    });
    await expect(service.search('run-1', 5, '/agents')).resolves.toEqual([]);
    expect(q.reads).toEqual([]);
  });

  it('the search stays scoped to the viewer’s level', async () => {
    const q = queries();
    await dashboard(q, { kinds: ['clinic'] }, context21([C1, U1])).search('x', 5, '/agents');
    expect(q.reads.length).toBeGreaterThan(0);
    expect(q.reads.every((read) => read?.tenant === 'C1')).toBe(true);
  });
});

describe('GET <api>/tenancy: the Organization, labelled', () => {
  it("labels the chain down to the scoped level with the app's labeler", async () => {
    const labels = async (tenants: Level[]) =>
      Object.fromEntries(tenants.map((t) => [t.id, t.id === 'C1' ? 'Clinic One' : 'Unit One']));
    expect(
      await dashboard(queries(), 'inherit', context21([C1, U1], { labels })).tenancy(),
    ).toEqual({
      enabled: true,
      scope: 'tenant',
      tenant: { id: 'U1', kind: 'unit', label: 'Unit One' },
      chain: [
        { id: 'C1', kind: 'clinic', label: 'Clinic One' },
        { id: 'U1', kind: 'unit', label: 'Unit One' },
      ],
    });
    expect(
      (await dashboard(queries(), { kinds: ['clinic'] }, context21([C1, U1], { labels })).tenancy())
        .chain,
    ).toEqual([{ id: 'C1', kind: 'clinic', label: 'Clinic One' }]);
  });

  it('falls back to slug, then id, when there is no labeler or it fails', async () => {
    const failing = async () => {
      throw new Error('down');
    };
    for (const accessor of [context21([C1, U1]), context21([C1, U1], { labels: failing })]) {
      expect((await dashboard(queries(), 'inherit', accessor).tenancy()).chain).toEqual([
        { id: 'C1', kind: 'clinic', label: 'clinic-one' },
        { id: 'U1', kind: 'unit', label: 'U1' },
      ]);
    }
  });

  it('a flat tenant from an older context is its own chain', async () => {
    const flat = {
      tenancy: () => ({ enabled: true }),
      tenantFilter: () => ({ mode: 'tenant', tenant: { id: 't1', kind: 'org', source: 'app' } }),
    };
    expect((await dashboard(queries(), 'inherit', flat).tenancy()).chain).toEqual([
      { id: 't1', kind: 'org', label: 't1' },
    ]);
  });

  it('never throws: off, every tenant, and a missing required tenant', async () => {
    expect(await dashboard(queries(), false, context21([C1])).tenancy()).toMatchObject({
      enabled: false,
    });
    expect(await dashboard(queries(), 'inherit', context21('all')).tenancy()).toMatchObject({
      enabled: true,
      scope: 'all',
    });
    expect(
      await dashboard(queries(), 'inherit', context21(null, { required: true })).tenancy(),
    ).toEqual({ enabled: true, scope: 'tenantless', tenant: null, chain: [] });
  });
});
