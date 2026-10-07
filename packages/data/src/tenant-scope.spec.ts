import { describe, expect, it } from 'vitest';
import { TenantScopeRewriter } from './tenant-scope.js';

const scope = (options: { onMissingTenant?: 'reject' | 'passthrough' } = {}) =>
  new TenantScopeRewriter({ tenantColumn: 'base_id', scopedTables: ['vehicle'], ...options });

/** How many times the tenant predicate appears in the rewritten SQL. */
const predicates = (sql: string) => sql.match(/`base_id` = 'tenant-a'/g)?.length ?? 0;

describe('TenantScopeRewriter', () => {
  it('constrains a scoped table in the top-level FROM', () => {
    expect(predicates(scope().rewrite('SELECT id FROM vehicle', 'tenant-a'))).toBe(1);
  });

  it('rejects an existing predicate for another tenant', () => {
    expect(() =>
      scope().rewrite("SELECT id FROM vehicle WHERE base_id = 'tenant-b'", 'tenant-a'),
    ).toThrow(/tenant mismatch/);
  });

  describe('with no tenant for the session', () => {
    it('refuses a query on a scoped table by default', () => {
      expect(() => scope().rewrite('SELECT id FROM vehicle', undefined)).toThrow(/no tenant/);
      expect(() =>
        scope().rewrite(
          'SELECT id FROM depot WHERE id IN (SELECT depot_id FROM vehicle)',
          undefined,
        ),
      ).toThrow(/no tenant/);
    });

    it('still runs a query that reads no scoped table', () => {
      expect(scope().rewrite('SELECT id FROM depot', undefined)).toBe('SELECT id FROM depot');
    });

    it("passes it through unscoped under onMissingTenant: 'passthrough'", () => {
      const sql = 'SELECT id FROM vehicle';
      expect(scope({ onMissingTenant: 'passthrough' }).rewrite(sql, undefined)).toBe(sql);
    });
  });

  describe('subqueries outside FROM', () => {
    it('constrains a scoped table read in a WHERE subquery', () => {
      const out = scope().rewrite(
        'SELECT id FROM depot WHERE id IN (SELECT depot_id FROM vehicle)',
        'tenant-a',
      );
      expect(predicates(out)).toBe(1);
    });

    it('constrains a scoped table read in a select-list subquery', () => {
      const out = scope().rewrite(
        'SELECT id, (SELECT COUNT(*) FROM vehicle v) AS n FROM depot',
        'tenant-a',
      );
      expect(out).toMatch(/FROM `vehicle` AS `v` WHERE `base_id` = 'tenant-a'/);
    });

    it('constrains an EXISTS subquery and the outer query alike', () => {
      const out = scope().rewrite(
        'SELECT id FROM vehicle WHERE EXISTS (SELECT 1 FROM vehicle)',
        'tenant-a',
      );
      expect(predicates(out)).toBe(2);
    });

    it('rejects another tenant named inside a subquery', () => {
      expect(() =>
        scope().rewrite(
          "SELECT id FROM depot WHERE id IN (SELECT depot_id FROM vehicle WHERE base_id = 'tenant-b')",
          'tenant-a',
        ),
      ).toThrow(/tenant mismatch/);
    });

    it('rejects a UNION hidden in a subquery', () => {
      expect(() =>
        scope().rewrite(
          'SELECT id FROM depot WHERE id IN (SELECT depot_id FROM vehicle UNION SELECT 1)',
          'tenant-a',
        ),
      ).toThrow(/UNION/);
    });
  });
});
