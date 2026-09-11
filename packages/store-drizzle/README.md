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
DDL helper for a quick start), `DrizzleAgentStore`, and `DrizzleGovernanceQueries`. For production,
prefer your normal drizzle-kit migrations over the `ensureAgentSchema` helper.

## Upgrading a database that already exists

`ensureAgentSchema` is additive only — `CREATE TABLE IF NOT EXISTS` plus `CREATE INDEX IF NOT
EXISTS`, and an explicit add-column pass for columns this package introduced after a table shipped,
since the `CREATE TABLE` guard is inert against a table that already exists. Calling it on boot is
enough; it never drops a column or changes a type.

On your own drizzle-kit migrations, those additive statements are yours to write:

```sql
ALTER TABLE agent_thread ADD COLUMN default_agent TEXT;
ALTER TABLE agent_message ADD COLUMN run_id TEXT;
ALTER TABLE agent_message ADD COLUMN attachments TEXT;
CREATE INDEX agent_tool_call_message_idx ON agent_tool_call (message_id);
```

The index is not optional on Postgres: `agent_tool_call.message_id` carries a foreign key, and
Postgres — unlike MySQL — does not index one for you, while both message-scoped reads (the thread
reader's `IN (…)` and `truncateFrom`'s delete) filter on it.

## Attachment housekeeping

`referencedMediaIds(actorRef, mediaIds)` answers which of a set of media ids a message that still
exists carries, for one actor — the inverse of the host's own staged-media inventory, and the half a
sweep cannot work out for itself. It needs **no schema change**: it reads the `attachments` JSON
column messages have carried since attachments shipped, so an existing database answers correctly
the moment you upgrade, with nothing to backfill.

The match happens in memory rather than in SQL. The column holds an array of objects, every dialect
spells that query differently, and none of them can use an index for it; the scan is bounded to one
actor's attachment-bearing messages, and a message with no attachments never leaves the database.

A thread that was soft-deleted still counts as holding its references: the message rows survive, so
the bytes are still reachable from stored state. Delete the thread for real and the cascade makes
them collectable on the next sweep.

## Cost accounting

`DrizzleGovernanceQueries` resolves cost per usage row as `COALESCE(reportedCostUsd, tokens × pricing)`:
a gateway-reported `costUsd` wins when present, otherwise a cache-aware estimate against the current
`agent_model_pricing` row (cache-write/read tokens priced at their own nullable rates, falling back to
the input rate). See the [root README](https://github.com/DavideCarvalho/nestjs-agent#cost--governance)
for the full model.

## License

MIT © Davide Carvalho
