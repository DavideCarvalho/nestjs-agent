import { afterEach, describe, expect, it } from 'vitest';
import {
  type ContextTenantFilter,
  readTenancy,
  tenantRowFilter,
  tenantRowVisible,
  withContextTenant,
} from './tenancy.js';

const SLOT = Symbol.for('@dudousxd/nestjs-diagnostics:accessor');

/** A structural stand-in for `@dudousxd/nestjs-context`'s accessor. */
function accessor(enabled: boolean, filter: ContextTenantFilter, kinds?: string[]) {
  const asked: ({ kinds?: string[] } | undefined)[] = [];
  return {
    asked,
    tenancy: () => ({ enabled, ...(kinds ? { kinds } : {}) }),
    tenantFilter: (options?: { kinds?: string[] }) => {
      asked.push(options);
      return filter;
    },
  };
}

const T1 = { mode: 'tenant', tenant: { id: 't1', kind: 'organization', source: 'app' } } as const;

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[SLOT];
});

describe('readTenancy', () => {
  it('is off with no context, an old accessor, `false`, or the context switch off', () => {
    expect(readTenancy('inherit')).toEqual({ enabled: false });
    expect(readTenancy('inherit', { traceId: () => undefined })).toEqual({ enabled: false });
    expect(readTenancy(false, accessor(true, T1))).toEqual({ enabled: false });
    expect(readTenancy('inherit', accessor(false, T1))).toEqual({ enabled: false });
    expect(readTenancy({ enabled: 'inherit' }, accessor(false, T1))).toEqual({ enabled: false });
  });

  it('follows the context switch, and an explicit `enabled` wins over it', () => {
    expect(readTenancy('inherit', accessor(true, T1)).enabled).toBe(true);
    expect(readTenancy({ enabled: true }, accessor(false, T1)).enabled).toBe(true);
    expect(readTenancy({ enabled: false }, accessor(true, T1)).enabled).toBe(false);
  });

  it('reads the global slot when no accessor is injected', () => {
    (globalThis as Record<symbol, unknown>)[SLOT] = { current: accessor(true, T1) };
    const tenancy = readTenancy();
    expect(tenancy.enabled && tenancy.filter()).toEqual(T1);
  });

  it('passes its own `kinds` to the filter', () => {
    const a = accessor(true, { mode: 'tenantless' });
    const tenancy = readTenancy({ kinds: ['organization'] }, a);
    expect(tenancy.enabled && tenancy.filter()).toEqual({ mode: 'tenantless' });
    expect(a.asked).toEqual([{ kinds: ['organization'] }]);
  });
});

describe('tenantRowFilter + tenantRowVisible (the matching rule)', () => {
  const visible = (filter: ReturnType<typeof tenantRowFilter>) => ({
    own: tenantRowVisible(filter, 't1'),
    other: tenantRowVisible(filter, 't2'),
    none: tenantRowVisible(filter, null),
  });

  it('tenant mode: own rows only; rows with no tenant only when shared', () => {
    expect(visible(tenantRowFilter(readTenancy('inherit', accessor(true, T1))))).toEqual({
      own: true,
      other: false,
      none: false,
    });
    expect(
      visible(tenantRowFilter(readTenancy({ nullRows: 'shared' }, accessor(true, T1)))),
    ).toEqual({ own: true, other: false, none: true });
  });

  it('tenantless mode: only rows with no tenant', () => {
    const filter = tenantRowFilter(readTenancy('inherit', accessor(true, { mode: 'tenantless' })));
    expect(visible(filter)).toEqual({ own: false, other: false, none: true });
  });

  it('all and system modes, and tenancy off: every row', () => {
    for (const mode of ['all', 'system'] as const) {
      expect(tenantRowFilter(readTenancy('inherit', accessor(true, { mode })))).toBeUndefined();
    }
    expect(tenantRowFilter(readTenancy('inherit', accessor(false, T1)))).toBeUndefined();
    expect(visible(undefined)).toEqual({ own: true, other: true, none: true });
  });

  it('an explicit tenant wins over the context one', () => {
    const filter = tenantRowFilter(readTenancy('inherit', accessor(true, T1)), 't2');
    expect(visible(filter)).toEqual({ own: false, other: true, none: false });
    const fromTenantless = tenantRowFilter(
      readTenancy('inherit', accessor(true, { mode: 'tenantless' })),
      't2',
    );
    expect(visible(fromTenantless)).toEqual({ own: false, other: true, none: false });
  });
});

describe('withContextTenant', () => {
  it('fills an empty tenantRef from the context tenant', () => {
    expect(withContextTenant({ id: 'u1' }, readTenancy('inherit', accessor(true, T1)))).toEqual({
      id: 'u1',
      tenantRef: 't1',
    });
  });

  it('keeps a tenantRef the resolver set', () => {
    const actor = { id: 'u1', tenantRef: 'mine' };
    expect(withContextTenant(actor, readTenancy('inherit', accessor(true, T1)))).toBe(actor);
  });

  it('changes nothing with tenancy off or no tenant in scope', () => {
    const actor = { id: 'u1' };
    expect(withContextTenant(actor, readTenancy('inherit', accessor(false, T1)))).toBe(actor);
    expect(
      withContextTenant(actor, readTenancy('inherit', accessor(true, { mode: 'tenantless' }))),
    ).toBe(actor);
  });
});
