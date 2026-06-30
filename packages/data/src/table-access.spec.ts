import { describe, expect, it } from 'vitest';
import { GroupTableAccessPolicy } from './table-access.js';

describe('GroupTableAccessPolicy', () => {
  const policy = new GroupTableAccessPolicy({
    roleGroups: {
      ANALYST: ['OPERATIONAL', 'LOOKUPS'],
      ADMIN: ['OPERATIONAL', 'LOOKUPS', 'ADMIN_ONLY'],
    },
    tablesByGroup: {
      OPERATIONAL: ['vehicle', 'work_order'],
      LOOKUPS: ['base', 'unit_*'],
      ADMIN_ONLY: ['user', 'billing'],
    },
  });

  it('allows a role → group → table path', () => {
    expect(policy.canAccess('ANALYST', 'vehicle')).toBe(true);
    expect(policy.canAccess('ANALYST', 'unit_dictionary')).toBe(true);
  });

  it('denies a table in a group the role lacks', () => {
    expect(policy.canAccess('ANALYST', 'billing')).toBe(false);
  });

  it('denies an unclassified table (fail-closed)', () => {
    expect(policy.canAccess('ANALYST', 'secret_table')).toBe(false);
  });

  it('denies an undefined role (fail-closed)', () => {
    expect(policy.canAccess(undefined, 'vehicle')).toBe(false);
  });

  it('denies an unknown role (fail-closed)', () => {
    expect(policy.canAccess('GHOST', 'vehicle')).toBe(false);
  });
});
