---
'@dudousxd/nestjs-agent-store-drizzle': minor
'@dudousxd/nestjs-agent-store-mikro-orm': minor
---

A `schema` option puts the agent tables in their own Postgres schema (or MySQL database): `DrizzleAgentStoreModule.forRoot({ db, schema })` / `MikroOrmAgentStoreModule.forFeature({ schema })`, and on every store, sink and governance class. Every statement the stores issue names the schema (Drizzle `pgSchema`/`mysqlSchema` tables, MikroORM `em.fork({ schema })`, qualified raw SQL); the connection's `search_path` is never touched. `ensureAgentSchema` creates the schema and heals the tables in it, with catalog lookups, the boot marker and the advisory lock scoped to it. `agentSchemaDdl` / `agentSchemaSql` render the qualified DDL. SQLite with `schema` fails at boot. Without `schema` nothing changes. Drizzle also exports `pgAgentTables(schema)` / `mysqlAgentTables(schema)`.
