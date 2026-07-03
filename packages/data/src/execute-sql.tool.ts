import type { AiToolCtx, ToolHandler, ToolSpec } from '@dudousxd/nestjs-agent-core';
import { z } from 'zod';
import { injectLimit } from './limit.js';
import { SqlValidator } from './sql-validator.js';
import type { TableAccessPolicy } from './table-access.js';
import type { TenantScopeRewriter } from './tenant-scope.js';

/** App-supplied runner over a read-only connection pool. The package never opens a DB. */
export interface QueryRunner {
  run(sql: string): Promise<Record<string, unknown>[]>;
}

/** Dependencies for {@link createExecuteSqlTool}. */
export interface ExecuteSqlDeps {
  /** Runs the (already validated, scoped, and limited) SQL against the read-only pool. */
  runner: QueryRunner;
  /** Single-SELECT validator. Defaults to a fresh {@link SqlValidator}. */
  validator?: SqlValidator;
  /** Coarse table-level allowlist, checked for every referenced table. */
  tableAccess: TableAccessPolicy;
  /** Optional per-row tenant constraint applied before the query runs. */
  tenantScope?: TenantScopeRewriter;
  /** Row cap injected when the query has no LIMIT. Defaults to 100. */
  maxRows?: number;
}

export interface ExecuteSqlResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  sql: string;
  truncated?: true;
}

const DEFAULT_MAX_ROWS = 100;

/** Serialized rows above this size are truncated so a single tool result can't blow the context. */
const MAX_RESULT_BYTES = 256 * 1024;

const inputSchema = z.object({
  sql: z.string().min(1).describe('A single read-only MySQL SELECT statement'),
});

type ExecuteSqlInput = z.infer<typeof inputSchema>;

const DESCRIPTION =
  'Execute a single read-only MySQL SELECT statement. Use this to answer questions about real ' +
  'data. Only SELECT is allowed (no INSERT/UPDATE/DELETE/DDL). Access is restricted to the ' +
  'tables your role is permitted to read, results are capped, and tenant-scoped tables are ' +
  'automatically constrained to your current tenant.';

/**
 * Builds the governed `executeSql` read tool. The pipeline per call is:
 * validate (single SELECT) → assert table access for every referenced table →
 * tenant-scope rewrite (if configured) → inject LIMIT → run → return rows,
 * truncating the payload if it would exceed ~256KB.
 */
export function createExecuteSqlTool(deps: ExecuteSqlDeps): {
  spec: ToolSpec;
  handler: ToolHandler<ExecuteSqlInput>;
} {
  const validator = deps.validator ?? new SqlValidator();
  const maxRows = deps.maxRows ?? DEFAULT_MAX_ROWS;

  const spec: ToolSpec = {
    name: 'executeSql',
    kind: 'read',
    description: DESCRIPTION,
    inputSchema,
  };

  const handler: ToolHandler<ExecuteSqlInput> = {
    async execute(input: ExecuteSqlInput, ctx: AiToolCtx): Promise<ExecuteSqlResult> {
      const { tables } = validator.validate(input.sql);

      const roles = ctx.actor.roles ?? [];
      const forbidden = tables.filter((table) => !deps.tableAccess.canAccess(roles, table));
      if (forbidden.length > 0) {
        const formatted = forbidden.map((table) => `\`${table}\``).join(', ');
        const rolesLabel = roles.length > 0 ? roles.join(', ') : 'none';
        throw new Error(`Your roles (${rolesLabel}) are not allowed to query ${formatted}.`);
      }

      let sql = input.sql;
      if (deps.tenantScope) {
        sql = deps.tenantScope.rewrite(sql, ctx.tenantRef);
      }
      sql = injectLimit(sql, maxRows);

      const rows = await deps.runner.run(sql);
      return buildResult(rows, sql);
    },
  };

  return { spec, handler };
}

function buildResult(rows: Record<string, unknown>[], sql: string): ExecuteSqlResult {
  const rowCount = rows.length;
  if (byteLength(rows) <= MAX_RESULT_BYTES) {
    return { rows, rowCount, sql };
  }

  // Keep prefix rows until the serialized payload would exceed the cap.
  const kept: Record<string, unknown>[] = [];
  let size = 2; // opening + closing bracket of the JSON array
  for (const row of rows) {
    const rowSize = byteLength(row) + 1; // +1 for the joining comma
    if (size + rowSize > MAX_RESULT_BYTES) break;
    kept.push(row);
    size += rowSize;
  }

  return { rows: kept, rowCount, sql, truncated: true };
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}
