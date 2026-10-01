---
'@dudousxd/nestjs-agent-store-mikro-orm': minor
---

Fixes found by running every store suite on real Postgres 16 and MySQL 8.4 (through MikroORM's own
drivers) instead of SQLite only. `ensureAgentSchema` applies the schema side on the next boot — see
the README's upgrade note: on MySQL it rewrites the agent tables once.

- **Message order.** A transcript was ordered by `created_at` and then a random uuid, so two messages
  written in the same tick — every second on MySQL, whose `datetime` was whole seconds — could read
  back swapped. `agent_message` gains a nullable per-thread `seq`, assigned on append and copied in
  order on fork; rows from before sort first, as before.
- **MySQL timestamps** are `datetime(6)` (sub-second, like Postgres's `timestamptz`).
- **MySQL long text.** `content`, `reasoning`, error messages, memory text and stream frames are
  `longtext`: `text` stops at 64 KB and the insert failed past it.
- **MySQL actor isolation.** `actor_ref`, `tenant_ref` and the memory `scope`/`origin_actor_ref` take
  the binary collation of the host's charset (`utf8mb4_bin`): under `utf8mb4_unicode_ci`, two actors
  whose refs differed only in case listed each other's threads.
- **Postgres index.** `agent_tool_call.message_id` is indexed on Postgres too (MikroORM only indexes a
  many-to-one on MySQL/SQLite by itself).
- **Concurrent boot.** Several replicas running `ensureAgentSchema` on an empty Postgres at once no
  longer fail on `pg_type_typname_nsp_index`; the schema lock is now held on one pinned connection,
  so a pooled connection can no longer keep it after the heal.
- **`MikroOrmTokenStreamSink`** retries the lost `(run_id, seq)` race on Postgres and MySQL: a raw
  insert surfaces the driver's error (`23505`, `ER_DUP_ENTRY`, and InnoDB's deadlock victim), not
  MikroORM's translated exception, so the race was surfacing as a failed write.
- **`claimActiveStream`** re-claiming a thread the run already holds is admitted on a MySQL connection
  without `FOUND_ROWS`, which reports changed rather than matched rows.
- **`agentSchemaSql`** renders with the collation the host registered the entities with, instead of
  none — on MySQL the DDL it produced differed from the entities on every key column.
