import { Parser } from 'node-sql-parser';
import { describe, expect, it } from 'vitest';
import { TenantScopeRewriter } from './tenant-scope.js';

const scope = ({
  tables = ['vehicle'],
  ...options
}: { onMissingTenant?: 'reject' | 'passthrough'; tables?: string[] } = {}) =>
  new TenantScopeRewriter({ tenantColumn: 'base_id', scopedTables: tables, ...options });

/** How many times the tenant constraint was added to the rewritten SQL. */
const predicates = (sql: string) => sql.match(/`\.`base_id` = 'tenant-a'/g)?.length ?? 0;

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
      expect(out).toMatch(/FROM `vehicle` AS `v` WHERE `v`\.`base_id` = 'tenant-a'/);
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

  describe('an OR cannot stand in for the tenant constraint (security)', () => {
    /** Run the rewritten SQL's WHERE through the parser again and report its top-level shape. */
    const topLevel = (sql: string) => {
      const ast = new Parser().astify(sql, { database: 'MySQL' }) as unknown as {
        where: { operator: string; left: unknown; right: { left: { column: string } } };
      };
      return ast.where;
    };

    it('ANDs the tenant over the whole WHERE when the query names it under an OR', () => {
      const out = scope().rewrite(
        "SELECT id FROM vehicle WHERE base_id = 'tenant-a' OR 1 = 1",
        'tenant-a',
      );
      const where = topLevel(out);
      expect(where.operator).toBe('AND');
      expect(where.right.left.column).toBe('base_id');
      // The caller's OR stays together, inside parentheses, under the AND.
      expect(out).toMatch(
        /\(`base_id` = 'tenant-a' OR 1 = 1\) AND `vehicle`\.`base_id` = 'tenant-a'/,
      );
    });

    it('still ANDs it when the OR names the tenant on both sides', () => {
      const out = scope().rewrite(
        "SELECT id FROM vehicle WHERE base_id = 'tenant-a' OR base_id = 'tenant-a'",
        'tenant-a',
      );
      expect(topLevel(out).operator).toBe('AND');
    });

    it('ANDs it inside a subquery whose WHERE tries the same bypass', () => {
      const out = scope().rewrite(
        "SELECT id FROM depot WHERE id IN (SELECT depot_id FROM vehicle WHERE base_id = 'tenant-a' OR 1 = 1)",
        'tenant-a',
      );
      expect(out).toMatch(
        /FROM `vehicle` WHERE \(`base_id` = 'tenant-a' OR 1 = 1\) AND `vehicle`\.`base_id` = 'tenant-a'/,
      );
    });

    it('rejects an OR that names another tenant, top level or nested', () => {
      expect(() =>
        scope().rewrite(
          "SELECT id FROM vehicle WHERE base_id = 'tenant-a' OR base_id = 'tenant-b'",
          'tenant-a',
        ),
      ).toThrow(/tenant mismatch/);
      expect(() =>
        scope().rewrite(
          "SELECT id FROM depot WHERE EXISTS (SELECT 1 FROM vehicle WHERE 1 = 1 OR base_id = 'tenant-b')",
          'tenant-a',
        ),
      ).toThrow(/tenant mismatch/);
    });

    it('constrains each scoped table of a join by its own alias', () => {
      const out = scope({ tables: ['vehicle', 'trip'] }).rewrite(
        "SELECT v.id FROM vehicle v JOIN trip t ON t.vehicle_id = v.id WHERE v.base_id = 'tenant-a' OR 1 = 1",
        'tenant-a',
      );
      expect(out).toContain("`v`.`base_id` = 'tenant-a' AND `t`.`base_id` = 'tenant-a'");
      expect(topLevel(out).operator).toBe('AND');
    });
  });
});
