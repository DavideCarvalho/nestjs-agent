import { describe, expect, it } from 'vitest';
import { consoleTenancy } from './tenancy.js';

const clinic = { id: 'C1', kind: 'clinic', slug: 'clinic-one' };
const unit = { id: 'U1', kind: 'unit', slug: 'unit-one' };

function accessor(tenantFilter: () => unknown, labels?: Record<string, string>) {
  return {
    tenancy: () => ({ enabled: true, required: false }),
    tenantFilter,
    ...(labels ? { tenantLabels: async () => labels } : {}),
  };
}

describe('consoleTenancy', () => {
  it('falls back to the slug, then the id, for levels the labeler left out', async () => {
    const result = await consoleTenancy(
      'inherit',
      accessor(
        () => ({ mode: 'tenant', tenant: { ...unit, source: 'app' }, chain: [clinic, unit] }),
        { C1: 'Clinic One' },
      ),
    );
    expect(result.chain.map((level) => level.label)).toEqual(['Clinic One', 'unit-one']);
  });

  it('reads a missing required tenant as tenantless', async () => {
    const result = await consoleTenancy(
      'inherit',
      accessor(() => {
        throw Object.assign(new Error('tenant required'), { code: 'E_TENANT_REQUIRED' });
      }),
    );
    expect(result.scope).toBe('tenantless');
  });

  it('lets any other failure surface', async () => {
    await expect(
      consoleTenancy(
        'inherit',
        accessor(() => {
          throw new TypeError('broken accessor');
        }),
      ),
    ).rejects.toThrow(TypeError);
  });
});
