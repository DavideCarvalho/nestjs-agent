import { Parser } from 'node-sql-parser';

/**
 * Thrown when a statement is not a single, read-only SELECT — i.e. it is an
 * INSERT/UPDATE/DELETE, DDL, a CALL, a multi-statement string, or it fails to
 * parse. The handler surfaces `.message` to the model so it can re-plan.
 */
export class SqlValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SqlValidationError';
  }
}

/** Statement types that are categorically rejected (anything that writes or runs code). */
const FORBIDDEN_AST_TYPES = new Set([
  'insert',
  'update',
  'delete',
  'replace',
  'create',
  'drop',
  'alter',
  'truncate',
  'rename',
  'load_data',
  'lock',
  'unlock',
  'set',
  'call',
  'handler',
  'use',
  'grant',
  'revoke',
]);

export interface SqlValidationResult {
  /** Every base table the statement references (CTEs, joins, subqueries walked). */
  tables: string[];
}

/**
 * Parses SQL (MySQL dialect) and asserts it is a single SELECT, returning the
 * set of tables it touches. Domain-agnostic: it knows nothing about which
 * tables a caller may read — that is the `TableAccessPolicy`'s job.
 */
export class SqlValidator {
  private readonly parser = new Parser();

  /**
   * Throws `SqlValidationError` unless `sql` is exactly one SELECT statement.
   * On success returns the distinct base table names referenced.
   */
  validate(sql: string): SqlValidationResult {
    let parsed: unknown;
    try {
      parsed = this.parser.astify(sql, { database: 'MySQL' });
    } catch (err) {
      throw new SqlValidationError(`Parse error: ${(err as Error).message}`);
    }

    const statements = Array.isArray(parsed) ? parsed : [parsed];
    if (statements.length !== 1) {
      throw new SqlValidationError('Only a single statement is allowed');
    }

    const statement = statements[0] as { type?: string } | undefined;
    const type = (statement?.type ?? '').toLowerCase();

    if (type !== 'select') {
      if (['create', 'drop', 'alter', 'truncate', 'rename'].includes(type)) {
        throw new SqlValidationError('DDL is not allowed; only SELECT statements are accepted');
      }
      if (FORBIDDEN_AST_TYPES.has(type)) {
        throw new SqlValidationError(
          `${type.toUpperCase()} is not allowed; only SELECT statements are accepted`,
        );
      }
      throw new SqlValidationError(
        `Statement type "${type || 'unknown'}" is not allowed; only SELECT statements are accepted`,
      );
    }

    return { tables: this.extractReferencedTables(sql) };
  }

  /**
   * Distinct base table names a statement touches — walking CTEs, subqueries,
   * and joins. Backed by `node-sql-parser`'s `tableList`, which emits
   * `mode::db::table` strings; the table name is the last segment.
   */
  private extractReferencedTables(sql: string): string[] {
    const raw = this.parser.tableList(sql, { database: 'MySQL' });
    const tables = new Set<string>();
    for (const entry of raw) {
      const parts = entry.split('::');
      const table = parts[parts.length - 1];
      if (table && table !== 'null') tables.add(table);
    }
    return Array.from(tables);
  }
}
