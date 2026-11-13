import { describe, expect, it, vi } from 'vitest';
import { readTenancy, tenantLabels, tenantRowFilter, withContextTenant } from './tenancy.js';

class TenantRequiredError extends Error {
  readonly code = 'E_TENANT_REQUIRED';
}

interface Level {
  id: string;
  kind: string;
  slug?: string;
}

/**
 * A structural accessor that behaves like `@dudousxd/nestjs-context` 2.1: `kinds` matches a level
 * of the chain from the most specific up, `required` throws, and `tenantLabels` labels.
 */
function context21(tenant: (Level & { chain?: Level[] }) | null, required = false) {
  const tenantFilter = vi.fn((options?: { kinds?: string[]; required?: boolean }) => {
    const mustHave = options?.required ?? required;
    if (tenant === null) {
      if (mustHave) throw new TenantRequiredError();
      return { mode: 'tenantless' as const };
    }
    const chain = tenant.chain ?? [tenant];
    if (options?.kinds) {
      for (let i = chain.length - 1; i >= 0; i--) {
        const level = chain[i] as Level;
        if (options.kinds.includes(level.kind)) {
          return {
            mode: 'tenant' as const,
            tenant: { ...level, source: 'app' },
            chain: chain.slice(0, i + 1),
          };
        }
      }
      if (mustHave) throw new TenantRequiredError();
      return { mode: 'tenantless' as const };
    }
    return { mode: 'tenant' as const, tenant: { ...tenant, source: 'app' }, chain };
  });
  return { tenancy: () => ({ enabled: true, required }), tenantFilter };
}

const unit = {
  id: 'U1',
  kind: 'unit',
  chain: [
    { id: 'C1', kind: 'clinic' },
    { id: 'U1', kind: 'unit' },
  ],
};

describe('readTenancy on a nested tenant (context 2.1)', () => {
  it('forwards kinds, family and required to the filter', () => {
    const accessor = context21(unit);
    const tenancy = readTenancy({ kinds: ['clinic'], family: 'account', required: true }, accessor);
    if (tenancy.enabled) tenancy.filter();
    expect(accessor.tenantFilter).toHaveBeenLastCalledWith({
      kinds: ['clinic'],
      family: 'account',
      required: true,
    });
  });

  it('stamps the matching level: kinds clinic gives a unit request its clinic', () => {
    const accessor = context21(unit);
    expect(withContextTenant({ id: 'u' }, readTenancy({ kinds: ['clinic'] }, accessor))).toEqual({
      id: 'u',
      tenantRef: 'C1',
    });
    expect(withContextTenant({ id: 'u' }, readTenancy('inherit', accessor))).toEqual({
      id: 'u',
      tenantRef: 'U1',
    });
  });

  it('required: no tenant throws, and the `required: false` override never does', () => {
    const accessor = context21(null, true);
    expect(() => tenantRowFilter(readTenancy('inherit', accessor))).toThrow(TenantRequiredError);
    expect(tenantRowFilter(readTenancy('inherit', accessor, { required: false }))).toEqual({
      nulls: true,
    });
    expect(tenantRowFilter(readTenancy({ required: true }, accessor, { required: false }))).toEqual(
      { nulls: true },
    );
    expect(accessor.tenantFilter).toHaveBeenLastCalledWith({ required: false });
  });

  it('`false` stays off whatever the overrides', () => {
    expect(readTenancy(false, context21(unit), { required: false })).toEqual({ enabled: false });
  });
});

describe('tenantLabels', () => {
  const levels = [
    { id: 'C1', kind: 'clinic', slug: 'clinic-one' },
    { id: 'U1', kind: 'unit' },
  ];

  it("uses the context's labeler", async () => {
    const accessor = { tenantLabels: async () => ({ C1: 'Clinic One', U1: 'Unit One' }) };
    expect(await tenantLabels(levels, accessor)).toEqual({ C1: 'Clinic One', U1: 'Unit One' });
  });

  it('falls back to slug, then id, without a labeler or when it fails', async () => {
    const fallback = { C1: 'clinic-one', U1: 'U1' };
    expect(await tenantLabels(levels, {})).toEqual(fallback);
    expect(
      await tenantLabels(levels, {
        tenantLabels: async () => {
          throw new Error('down');
        },
      }),
    ).toEqual(fallback);
  });
});
