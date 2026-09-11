---
'@dudousxd/nestjs-agent-store-mikro-orm': minor
---

Heal the schema on SQLite, and refuse to record a heal that did not apply.

`ensureAgentSchema` kept the statements of the update diff whose target table is an agent table. On
MySQL and Postgres a missing column is `alter table agent_thread add column …`, which that keeps. On
SQLite/libsql there is no such statement: MikroORM rewrites the table — `create table
agent_thread__temp_alter`, `insert … select`, `drop table`, `rename to` — and every one of those was
filtered out, the temp table not being in the owned set and `insert`/`drop` not being matched at all.

So the heal ran, applied nothing, raised nothing — and then wrote the fingerprint, which is the part
that made it permanent: every later boot compared fingerprints, matched, and returned before ever
looking at the database again. Measured on a thread table missing four columns, the heal left
`id, actor_ref, title, transient, created_at, updated_at` and reported success.

Two changes, either of which would have caught it:

- The statement filter now keeps a statement when EVERY table it names is one this store owns —
  which admits the whole rebuild sequence, and is also what keeps its `drop table` from ever pointing
  at a host table. On SQLite the rebuild runs with foreign-key enforcement off and restored
  afterwards: dropping `agent_thread` with enforcement on fires the children's `on delete cascade`,
  taking every message, tool call and usage row with it.
- The heal then re-diffs, and throws the new `AgentSchemaHealError` when structure the diff asked for
  is still pending. The fingerprint is written only on the way out, so a heal that did not happen
  cannot record itself as the applied schema — the next boot introspects again instead of returning
  early forever.

**Upgrading.** Nothing to run. A deployment whose agent tables are already current sees no change:
the diff is empty, so there is nothing to apply and nothing pending. A SQLite/libsql deployment that
silently missed a column heals on the next boot — the rebuild preserves the rows, and the fingerprint
is recorded only once the columns are actually there. A deployment whose database rejects the DDL
(no DDL grant, a managed schema) now fails the boot loudly with the pending statements in the
message, instead of starting against a schema the store cannot use; apply them from
`agentSchemaSql()` in a migration.
