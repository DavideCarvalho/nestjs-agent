---
'@dudousxd/nestjs-agent-store-mikro-orm': patch
---

The boot heal keeps every MySQL column in the collation its entity declares. MikroORM before 7.2 renders no `collate` clause in `create table` / `add column` and does not diff collations, so the heal created every agent column in the table default (`utf8mb4_0900_ai_ci` on MySQL 8, case-insensitive), including `agent_channel_state.key` declared `utf8mb4_bin`: provider message ids that differed only by case collided. `ensureAgentSchema` now reads the actual collations and corrects every column that differs, one `alter table … modify` per table with foreign-key checks off on that connection, so keys and the columns that reference them change together. On a populated table it first checks that no unique key would merge rows and no child would lose its parent under the declared collation; if one would, it alters nothing, records no fingerprint and throws `AgentSchemaCollationError` with the conflicting key. The fingerprint now covers collations (schema revision 2), so a database an earlier version healed is corrected once on the next boot. Apps on `autoSchema` still need no migrations. Postgres and SQLite are unaffected.

The governance read-model also accepts the `proposed` and `expired` tool-call status filters, and an independent proposal's tool-call record now follows the proposal (see `@dudousxd/nestjs-agent-core`).
