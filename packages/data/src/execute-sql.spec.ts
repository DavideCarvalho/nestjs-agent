import type { AiToolCtx } from '@dudousxd/nestjs-agent-core';
import { describe, expect, it } from 'vitest';
import { type QueryRunner, createExecuteSqlTool } from './execute-sql.tool.js';
import { GroupTableAccessPolicy } from './table-access.js';
import { TenantScopeRewriter } from './tenant-scope.js';

class FakeRunner implements QueryRunner {
  lastSql: string | undefined;
  constructor(private readonly rows: Record<string, unknown>[]) {}
  async run(sql: string): Promise<Record<string, unknown>[]> {
    this.lastSql = sql;
    return this.rows;
  }
}

function ctx(overrides: Partial<AiToolCtx> = {}): AiToolCtx {
  const actorRole = overrides.actorRole ?? 'ANALYST';
  return {
    actorId: 'actor-1',
    actorRole,
    threadId: 'thread-1',
    runId: 'run-1',
    requestId: 'req-1',
    actor: { id: 'actor-1', role: actorRole },
    ...overrides,
  };
}

const tableAccess = new GroupTableAccessPolicy({
  roleGroups: { ANALYST: ['OPERATIONAL'] },
  tablesByGroup: { OPERATIONAL: ['vehicle'], ADMIN_ONLY: ['user'] },
});

describe('createExecuteSqlTool', () => {
  it('runs a SELECT on an allowed table and injects a LIMIT', async () => {
    const runner = new FakeRunner([{ id: 1 }, { id: 2 }]);
    const { spec, handler } = createExecuteSqlTool({ runner, tableAccess });

    expect(spec.name).toBe('executeSql');
    expect(spec.kind).toBe('read');

    const result = await handler.execute({ sql: 'SELECT id FROM vehicle' }, ctx());

    expect(result).toMatchObject({ rows: [{ id: 1 }, { id: 2 }], rowCount: 2 });
    expect(runner.lastSql).toContain('LIMIT 100');
    expect(runner.lastSql).toContain('vehicle');
  });

  it('throws when the query touches a denied table', async () => {
    const runner = new FakeRunner([]);
    const { handler } = createExecuteSqlTool({ runner, tableAccess });

    await expect(handler.execute({ sql: 'SELECT id FROM user' }, ctx())).rejects.toThrow(
      /not allowed to query/,
    );
    expect(runner.lastSql).toBeUndefined();
  });

  it('constrains a scoped table to the tenant predicate', async () => {
    const runner = new FakeRunner([{ id: 1 }]);
    const tenantScope = new TenantScopeRewriter({
      tenantColumn: 'base_id',
      scopedTables: ['vehicle'],
    });
    const { handler } = createExecuteSqlTool({ runner, tableAccess, tenantScope });

    await handler.execute({ sql: 'SELECT id FROM vehicle' }, ctx({ tenantRef: 'tenant-abc' }));

    expect(runner.lastSql).toContain('base_id');
    expect(runner.lastSql).toContain('tenant-abc');
  });

  it('passes through unchanged when tenantRef is undefined (privileged)', async () => {
    const runner = new FakeRunner([{ id: 1 }]);
    const tenantScope = new TenantScopeRewriter({
      tenantColumn: 'base_id',
      scopedTables: ['vehicle'],
    });
    const { handler } = createExecuteSqlTool({ runner, tableAccess, tenantScope });

    await handler.execute({ sql: 'SELECT id FROM vehicle' }, ctx({ tenantRef: undefined }));

    expect(runner.lastSql).not.toContain('base_id');
  });
});
