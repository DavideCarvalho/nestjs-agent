import type { AST } from 'node-sql-parser';
import { Parser } from 'node-sql-parser';

/** Configuration for {@link TenantScopeRewriter}. */
export interface TenantScopeConfig {
  /** The column that carries the tenant key on every scoped table (e.g. `base_id`, `org_id`). */
  tenantColumn: string;
  /** Tables that must be constrained to the caller's tenant when referenced. */
  scopedTables: string[];
  /**
   * What a query on a scoped table does when the caller has no `tenantRef`: `'reject'` (default)
   * refuses it; `'passthrough'` runs it unscoped — the privileged path, for an app where a missing
   * tenant means "sees every tenant" (an internal admin). A query that touches no scoped table runs
   * either way.
   */
  onMissingTenant?: 'reject' | 'passthrough';
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
 * single tenant: the SELECT's WHERE is parenthesised whole and
 * `<alias>.<tenantColumn> = '<tenantRef>'` is AND-ed to it, for every scoped
 * table in its FROM — always, even when the query already names the tenant
 * (an `OR` can make such a predicate constrain nothing). This applies to each
 * SELECT that reads a scoped table — the top-level one and every
 * subquery (in the select list, WHERE, HAVING, a JOIN's ON …). An existing
 * predicate for a different tenant is rejected (no cross-tenant reads).
 *
 * `tenantRef === undefined` on a query that reads a scoped table is refused,
 * unless `onMissingTenant: 'passthrough'` makes it the privileged path that runs
 * the SQL unchanged.
 *
 * Scoped mode rejects CTEs, UNION/INTERSECT/EXCEPT, and subqueries in FROM, at
 * any depth: those make it impossible to statically guarantee every
 * tenant-bearing source is constrained, so we fail closed and ask the caller to
 * rephrase.
 */
export class TenantScopeRewriter {
  private readonly parser = new Parser();
  private readonly tenantColumn: string;
  private readonly scopedTables: Set<string>;
  private readonly onMissingTenant: 'reject' | 'passthrough';

  constructor(config: TenantScopeConfig) {
    this.tenantColumn = config.tenantColumn;
    this.scopedTables = new Set(config.scopedTables);
    this.onMissingTenant = config.onMissingTenant ?? 'reject';
  }

  /**
   * Rewrite `sql` to constrain scoped tables to `tenantRef`. Undefined → refused when the query
   * reads a scoped table, unless `onMissingTenant: 'passthrough'`.
   */
  rewrite(sql: string, tenantRef: string | undefined): string {
    if (tenantRef === undefined && this.onMissingTenant === 'passthrough') return sql;

    const parsed = this.parser.astify(sql, { database: 'MySQL' });
    const ast = (Array.isArray(parsed) ? parsed[0] : parsed) as SelectAst;

    if (ast.type !== 'select') {
      throw new Error('tenant scope: only SELECT is supported');
    }

    const selects = collectSelects(ast);
    const readsScoped = selects.some((select) =>
      (select.from ?? []).some(
        (entry) => typeof entry.table === 'string' && this.scopedTables.has(entry.table),
      ),
    );
    if (!readsScoped) return sql;
    if (tenantRef === undefined) {
      throw new Error(
        'tenant scope: no tenant for this session — a query on a tenant-scoped table needs one',
      );
    }

    for (const select of selects) this.scopeSelect(select, tenantRef);
    return this.parser.sqlify(ast as unknown as AST, { database: 'MySQL' });
  }

  /** Constrain one SELECT's own FROM — its subqueries are scoped on their own. */
  private scopeSelect(ast: SelectAst, tenantRef: string): void {
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
    if (scopedFrom.length === 0) return;

    // A literal naming another tenant anywhere in the WHERE is refused outright. One naming THIS
    // tenant proves nothing — under an `OR` (`tenant = 'x' OR 1 = 1`) it constrains no row — so it
    // never stands in for the constraint below.
    for (const predicate of this.collectTenantPredicates(ast.where)) {
      if (predicate.value !== tenantRef) {
        throw new Error(
          'tenant scope: tenant mismatch — query targets a tenant other than the current session',
        );
      }
    }

    // The caller's WHERE, parenthesised whole, AND every scoped table's own tenant equality —
    // qualified by its alias, so a join or a correlated subquery cannot point it elsewhere.
    let where: unknown = ast.where == null ? null : parenthesised(ast.where);
    for (const entry of scopedFrom) {
      where = this.andCondition(
        where,
        this.buildTenantEquality(entry.as ?? entry.table, tenantRef),
      );
    }
    ast.where = where;
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

  private buildTenantEquality(tableAlias: string, tenantRef: string): BinaryExpr {
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

/**
 * Every SELECT in the tree, the root first: the statement itself and each subquery wherever it
 * sits — the select list, WHERE, HAVING, a JOIN's ON, a FROM (which `scopeSelect` then refuses).
 */
/** `node` with the parser's own parentheses flag set, so it prints — and binds — as one term. */
function parenthesised(node: unknown): unknown {
  return typeof node === 'object' && node !== null ? { ...node, parentheses: true } : node;
}

function collectSelects(root: SelectAst): SelectAst[] {
  const found: SelectAst[] = [];
  const walk = (node: unknown): void => {
    if (typeof node !== 'object' || node === null) return;
    if (Array.isArray(node)) {
      for (const item of node) walk(item);
      return;
    }
    if ((node as { type?: unknown }).type === 'select') found.push(node as SelectAst);
    for (const value of Object.values(node)) walk(value);
  };
  walk(root);
  return found;
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
