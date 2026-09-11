---
'@dudousxd/nestjs-agent-store-drizzle': patch
---

Declare an index on `agent_tool_call.message_id`.

The column carried a foreign key and no index. MySQL indexes a foreign key column for you; **Postgres
does not** — and both message-scoped reads filter on it: the thread reader's `IN (…)` over a turn's
calls, and `truncateFrom`'s delete of everything from a message onward.

`agent_tool_call_message_idx` is now declared in `schema.ts` and created by `ensureAgentSchema`.

The MikroORM adapter needs no change: the ORM's schema generator indexes every `m:1` on every SQL
platform (`AbstractSqlPlatform.indexForeignKeys()`), so `agent_tool_call_message_id_index` already
ships there — a second declared index would be a duplicate on every dialect. Its db spec now pins
that coverage rather than assuming it.

**Upgrading.** `ensureAgentSchema` issues `CREATE INDEX IF NOT EXISTS` on every boot, so an existing
deployment picks it up with no action. A host on its own drizzle-kit migrations must add
`CREATE INDEX agent_tool_call_message_idx ON agent_tool_call (message_id)`.
