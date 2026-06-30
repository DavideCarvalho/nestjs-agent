# `@dudousxd/nestjs-agent-data`

> 🪺 Part of the [Aviary](https://davidecarvalho.github.io/aviary) · a governed SQL tool for [`@dudousxd/nestjs-agent`](https://www.npmjs.com/package/@dudousxd/nestjs-agent).

Give the model **read-only SQL access without handing it the database**. Every query is:

1. **AST-validated** — single `SELECT` only (rejects writes/DDL/multi-statement), via `node-sql-parser`.
2. **Authorized** — checked against a **fail-closed** table-access policy (a table in no allowed group is denied).
3. **Tenant-scoped** (optional) — rewritten to add `tenantColumn = tenantRef` for scoped tables; rejects CTE/UNION/subquery-in-FROM.
4. **Capped** — a `LIMIT` is injected before your runner ever touches the DB.

The package never opens a connection — you inject a `QueryRunner` over your read-only pool.

## Install

```bash
pnpm add @dudousxd/nestjs-agent-data
```

## Use

```ts
import {
  createExecuteSqlTool,
  GroupTableAccessPolicy,
  TenantScopeRewriter,
} from '@dudousxd/nestjs-agent-data';

const { spec, handler } = createExecuteSqlTool({
  runner: { run: (sql) => readOnlyPool.query(sql) },
  tableAccess: new GroupTableAccessPolicy({ roleGroups, tablesByGroup }),
  tenantScope: new TenantScopeRewriter({ tenantColumn: 'tenant_id', scopedTables: ['orders'] }),
  maxRows: 100,
});
// register `spec` + `handler` with the agent's ToolRegistry (or wrap in an @AiTool provider)
```

## License

MIT © Davide Carvalho
