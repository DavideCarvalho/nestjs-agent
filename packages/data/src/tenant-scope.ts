import type { AST } from 'node-sql-parser';
import { Parser } from 'node-sql-parser';

/** Configuration for {@link TenantScopeRewriter}. */
export interface TenantScopeConfig {
  /** The column that carries the tenant key on every scoped table (e.g. `base_id`, `org_id`). */
  tenantColumn: string;
  /** Tables that must be constrained to the caller's tenant when referenced. */
  scopedTables: string[];
}

interface FromEntry {
  table?: string;
  as?: string | null;
  join?: string;
  expr?: { ast?: unknown };
}

interface SelectAst {
  type: string;
  with?: unknown;
  from?: FromEntry[];
  where?: unknown;
  _next?: unknown;
}

interface BinaryExpr {
  type: 'binary_expr';
  operator: string;
  left: unknown;
  right: unknown;
}

interface ColumnRef {
  type: 'column_ref';
  table: string | null;
  column: string;
}

interface ExtractedPredicate {
  tableAlias: string | null;
  value: string;
}

const STRING_LITERAL_TYPES = new Set(['string', 'single_quote_string', 'double_quote_string']);

/**
 * Rewrites a SELECT so every reference to a scoped table is constrained to a
 * single tenant: `<tenantColumn> = '<tenantRef>'` is AND-ed into the WHERE for
 * each scoped table in the FROM. An existing predicate for a different tenant
 * is rejected (no cross-tenant reads). `tenantRef === undefined` is the
 * privileged path and passes the SQL through unchanged.
 *
 * Scoped mode rejects CTEs, UNION/INTERSECT/EXCEPT, and subqueries in FROM:
 * those make it impossible to statically guarantee every tenant-bearing source
 * is constrained, so we fail closed and ask the caller to rephrase.
 */
export class TenantScopeRewriter {
  private readonly parser = new Parser();
  private readonly tenantColumn: string;
  private readonly scopedTables: Set<string>;

  constructor(config: TenantScopeConfig) {
    this.tenantColumn = config.tenantColumn;
    this.scopedTables = new Set(config.scopedTables);
  }

  /** Rewrite `sql` to constrain scoped tables to `tenantRef`. Undefined → pass through. */
  rewrite(sql: string, tenantRef: string | undefined): string {
    if (tenantRef === undefined) return sql;

    const parsed = this.parser.astify(sql, { database: 'MySQL' });
    const ast = (Array.isArray(parsed) ? parsed[0] : parsed) as SelectAst;

    if (ast.type !== 'select') {
      throw new Error('tenant scope: only SELECT is supported');
    }
    if (ast.with) {
      throw new Error(
        'tenant scope: WITH (CTE) is not supported in scoped mode — rewrite using JOINs/subqueries in FROM',
      );
    }
    if (ast._next) {
      throw new Error(
        'tenant scope: UNION/INTERSECT/EXCEPT is not supported in scoped mode — run each branch as a separate query',
      );
    }

    const fromEntries = ast.from ?? [];
    for (const entry of fromEntries) {
      if (!entry.table && entry.expr?.ast) {
        throw new Error('tenant scope: subqueries in FROM are not supported in scoped mode');
      }
    }

    const scopedFrom = fromEntries.filter(
      (entry): entry is FromEntry & { table: string } =>
        typeof entry.table === 'string' && this.scopedTables.has(entry.table),
    );
    if (scopedFrom.length === 0) return sql;

    const existing = this.collectTenantPredicates(ast.where);
    for (const predicate of existing) {
      if (predicate.value !== tenantRef) {
        throw new Error(
          'tenant scope: tenant mismatch — query targets a tenant other than the current session',
        );
      }
    }

    const coveredAliases = new Set(existing.map((predicate) => predicate.tableAlias));
    for (const entry of scopedFrom) {
      const alias = entry.as ?? entry.table;
      const isAmbiguous = scopedFrom.length > 1;
      const covered = coveredAliases.has(alias) || (!isAmbiguous && coveredAliases.has(null));
      if (covered) continue;
      ast.where = this.andCondition(
        ast.where,
        this.buildTenantEquality(isAmbiguous ? alias : null, tenantRef),
      );
    }

    return this.parser.sqlify(ast as unknown as AST, { database: 'MySQL' });
  }

  private collectTenantPredicates(where: unknown): ExtractedPredicate[] {
    if (!isBinaryExpr(where)) return [];
    if (where.operator === 'AND' || where.operator === 'OR') {
      return [
        ...this.collectTenantPredicates(where.left),
        ...this.collectTenantPredicates(where.right),
      ];
    }
    if (where.operator !== '=') return [];
    const lhs = where.left;
    const rhs = where.right;
    if (!isColumnRef(lhs) || lhs.column !== this.tenantColumn) return [];
    if (!isStringLiteral(rhs)) return [];
    return [{ tableAlias: lhs.table ?? null, value: rhs.value }];
  }

  private buildTenantEquality(tableAlias: string | null, tenantRef: string): BinaryExpr {
    return {
      type: 'binary_expr',
      operator: '=',
      left: { type: 'column_ref', table: tableAlias, column: this.tenantColumn },
      right: { type: 'single_quote_string', value: tenantRef },
    };
  }

  private andCondition(existing: unknown, added: BinaryExpr): BinaryExpr {
    if (existing == null) return added;
    return {
      type: 'binary_expr',
      operator: 'AND',
      left: existing,
      right: added,
    };
  }
}

function isBinaryExpr(value: unknown): value is BinaryExpr {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'binary_expr'
  );
}

function isColumnRef(value: unknown): value is ColumnRef {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { type?: unknown }).type === 'column_ref'
  );
}

function isStringLiteral(value: unknown): value is { type: string; value: string } {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { type?: unknown }).type === 'string' &&
    STRING_LITERAL_TYPES.has((value as { type: string }).type) &&
    typeof (value as { value?: unknown }).value === 'string'
  );
}
