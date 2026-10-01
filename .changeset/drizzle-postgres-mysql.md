---
'@dudousxd/nestjs-agent-store-drizzle': minor
---

The Drizzle store runs on **Postgres and MySQL**, not only SQLite. `pgAgentSchema` and
`mysqlAgentSchema` declare the same tables, columns and property names as `agentSchema` in each
dialect's types (`jsonb`/`json`, `timestamptz(3)`/`datetime(3)`, `longtext` on MySQL where `text`
stops at 64 KB, `double` for prices). Build the handle with your dialect's schema and pass it in as
before — `DrizzleAgentStore`, `DrizzleGovernanceQueries`, `DrizzleMemoryProvider`,
`DrizzlePricingStore`, `DrizzleConfirmTokenStore`, `DrizzleTokenStreamSink`, `DrizzleRagIngestionLog`
and `ensureAgentSchema` read the dialect off the handle; the dialect differences (`RETURNING`, upserts,
`INSERT IGNORE`, raw statements) are handled inside. `AgentDrizzleDb` widens to the three database
types.

`ensureAgentSchema` now renders its DDL from the schema objects instead of a hand-kept SQLite list,
adds any column or index a running database lacks, and on Postgres/MySQL holds a cross-replica lock
so replicas booting an empty database at once do not race their `CREATE TABLE`s.

Fixed along the way, on every dialect: messages read back in the order they were appended. They were
ordered by `created_at` and then a random uuid, so two messages written in the same millisecond (a
turn's assistant and tool messages) could swap. `agent_message` gains a nullable per-thread `seq`,
assigned on append and copied in order on fork; rows from before sort first, as before.
`agentSchema` now also lists `agentStreamFrame`. Every store suite runs on SQLite, Postgres 16 and
MySQL 8.4 in CI.
