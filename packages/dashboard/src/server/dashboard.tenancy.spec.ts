import type { AgentGovernanceQueries, TenantRowFilter } from '@dudousxd/nestjs-agent-core';
import { NotFoundException, NotImplementedException } from '@nestjs/common';
import { describe, expect, it } from 'vitest';
import { DashboardService } from './dashboard.service.js';

type Filter =
  | { mode: 'system' }
  | { mode: 'all' }
  | { mode: 'tenantless' }
  | { mode: 'tenant'; tenant: { id: string; kind: string; source: string } };

function context(enabled: boolean, filter: Filter) {
  return { tenancy: () => ({ enabled }), tenantFilter: () => filter };
}

/**
 * Governance queries that answer empty everywhere and record which view a read went through: the
 * unscoped one (`null`) or the `forTenant` view of a filter.
 */
function queries(withForTenant = true) {
  const reads: (TenantRowFilter | null)[] = [];
  const view = (filter: TenantRowFilter | null): AgentGovernanceQueries =>
    new Proxy({} as AgentGovernanceQueries, {
      get(_target, name) {
        if (name === 'forTenant') {
          return withForTenant && filter === null
            ? (next: TenantRowFilter) => view(next)
            : undefined;
        }
        if (name === 'then') return undefined;
        return async () => {
          reads.push(filter);
          return name === 'runDetail' || name === 'threadDetail'
            ? null
            : name === 'runMetrics'
              ? {}
              : String(name).endsWith('Page')
                ? { rows: [], total: 0, page: 1, pageSize: 10 }
                : [];
        };
      },
    });
  return { reads, root: view(null) };
}

const range = { fromDay: '2026-11-01', toDay: '2026-11-12' };
const T1: Filter = { mode: 'tenant', tenant: { id: 't1', kind: 'organization', source: 'app' } };

describe('DashboardService tenancy', () => {
  it('off (no context, context off, or `tenancy: false`): reads the unscoped queries', async () => {
    for (const [options, accessor] of [
      [undefined, undefined],
      [undefined, context(false, T1)],
      [{ tenancy: false as const }, context(true, T1)],
    ] as const) {
      const q = queries();
      const service = new DashboardService(
        q.root,
        undefined,
        undefined,
        undefined,
        options,
        accessor,
      );
      await service.spend(range);
      await service.recentThreads(10);
      expect(q.reads.every((read) => read === null)).toBe(true);
    }
  });

  it("scopes every read to the viewer's context tenant", async () => {
    const q = queries();
    const service = new DashboardService(
      q.root,
      undefined,
      undefined,
      undefined,
      undefined,
      context(true, T1),
    );
    await service.spend(range);
    await service.reliability(range);
    await service.threadsPage({ page: 1, pageSize: 10 });
    await service.runsPage({ page: 1, pageSize: 10 });
    await service.approvalsPage({ page: 1, pageSize: 10 });
    await service.toolStats(range);
    expect(q.reads.length).toBeGreaterThan(0);
    expect(q.reads.every((read) => read?.tenant === 't1' && read.nulls === false)).toBe(true);
  });

  it('a tenantless viewer sees rows with no tenant; `nullRows: shared` adds them for a tenant', async () => {
    const tenantless = queries();
    await new DashboardService(
      tenantless.root,
      undefined,
      undefined,
      undefined,
      undefined,
      context(true, { mode: 'tenantless' }),
    ).recentRuns(5);
    expect(tenantless.reads).toEqual([{ nulls: true }]);

    const shared = queries();
    await new DashboardService(
      shared.root,
      undefined,
      undefined,
      undefined,
      { tenancy: { nullRows: 'shared' } },
      context(true, T1),
    ).recentRuns(5);
    expect(shared.reads).toEqual([{ tenant: 't1', nulls: true }]);
  });

  it('inside allTenants: unscoped', async () => {
    const q = queries();
    await new DashboardService(
      q.root,
      undefined,
      undefined,
      undefined,
      undefined,
      context(true, { mode: 'all' }),
    ).recentRuns(5);
    expect(q.reads).toEqual([null]);
  });

  it('a thread or run outside the scope is not found (404)', async () => {
    const service = new DashboardService(
      queries().root,
      undefined,
      undefined,
      undefined,
      undefined,
      context(true, T1),
    );
    await expect(service.runDetail('run-1')).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.threadDetail({ threadId: 'th-1', messageLimit: 10, runLimit: 10 }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('refuses (501) when the store cannot be narrowed, rather than show every tenant', async () => {
    const service = new DashboardService(
      queries(false).root,
      undefined,
      undefined,
      undefined,
      undefined,
      context(true, T1),
    );
    await expect(service.spend(range)).rejects.toBeInstanceOf(NotImplementedException);
  });
});
