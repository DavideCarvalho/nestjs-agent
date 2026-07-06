# `@dudousxd/nestjs-agent-store-drizzle`

> 🪺 Part of the [Aviary](https://davidecarvalho.github.io/aviary) · a persistence adapter for [`@dudousxd/nestjs-agent`](https://www.npmjs.com/package/@dudousxd/nestjs-agent).

Drizzle persistence for the agent — threads, messages, tool calls, token usage, and model pricing.
The same `AgentStore` SPI as the MikroORM adapter, on a second ORM, proving the store is ORM-portable.
It also binds `DrizzleGovernanceQueries` to `AGENT_GOVERNANCE_QUERIES`, the read-model the dashboard
and Telescope surfaces read spend/usage from.

## Install

```bash
pnpm add @dudousxd/nestjs-agent-store-drizzle drizzle-orm
```

## Use

The host app owns the connection and passes in an already-opened Drizzle handle — this module never
opens one itself. Any SQLite-dialect driver works (better-sqlite3, libsql, D1, …).

```ts
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { DrizzleAgentStoreModule, agentSchema, ensureAgentSchema } from '@dudousxd/nestjs-agent-store-drizzle';

const db = drizzle(new Database('app.db'), { schema: agentSchema });
await ensureAgentSchema(db); // idempotent CREATE TABLE IF NOT EXISTS — or run your own migrations

@Module({
  imports: [
    DrizzleAgentStoreModule.forRoot({ db }), // binds AGENT_STORE + AGENT_GOVERNANCE_QUERIES
    AgentModule.forRoot({ /* store comes from AGENT_STORE */ model, modelId }),
  ],
})
export class AppModule {}
```

The package ships the `agentSchema` (Drizzle tables), `ensureAgentSchema` (a non-destructive
`CREATE TABLE IF NOT EXISTS` helper for a quick start), `DrizzleAgentStore`, and
`DrizzleGovernanceQueries`. For production, prefer your normal drizzle-kit migrations over the
`ensureAgentSchema` helper.

## Cost accounting

`DrizzleGovernanceQueries` resolves cost per usage row as `COALESCE(reportedCostUsd, tokens × pricing)`:
a gateway-reported `costUsd` wins when present, otherwise a cache-aware estimate against the current
`agent_model_pricing` row (cache-write/read tokens priced at their own nullable rates, falling back to
the input rate). See the [root README](https://github.com/DavideCarvalho/nestjs-agent#cost--governance)
for the full model.

## License

MIT © Davide Carvalho
