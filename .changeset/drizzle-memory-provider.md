---
'@dudousxd/nestjs-agent-store-drizzle': minor
---

`agent_memory` and `DrizzleMemoryProvider` — the same memory storage the MikroORM adapter gained, on
this store's own schema and DDL pass, so a host does not pick its memory implementation by picking
its ORM.

- `agentSchema` gains `agentMemory`, with one unique index on (`scope`, `key`). That index is what
  the upsert conflicts against, and it doubles as the index every read uses — `list` filters
  `scope in (…)`, which is its leading column, so a second index on `scope` alone would be maintained
  on every write and read by nothing. `origin_thread_id` is deliberately not a foreign key, unlike
  every other table here: a memory outlives the conversation it came from, and a cascade off
  `agent_thread` would delete beliefs when a transcript aged out.
- `ensureAgentSchema` creates it. It needs no entry in the additive-column pass — that list exists for
  a column added to a table this package already shipped, and `CREATE TABLE IF NOT EXISTS` covers a
  whole new one on a database of any age. `key` and `text` are quoted in the DDL: both are keywords in
  at least one engine, and they are the SPI's own field names, which is worth more than dodging the
  quoting.
- `DrizzleMemoryProvider` implements `list`, `write` and `forget`. The scope filter is in the query;
  `forget` puts the actor's own scope in the `where`, so an id alone cannot reach a tenant's memory,
  and "no such id" and "not yours" answer identically. `write` upserts in one statement, and its
  conflict `set` names exactly what a rewrite may change — so `pinned`, `created_at` and `id` are
  left alone by construction rather than by an exclusion list anyone could forget to extend.
- `write` refuses an **agent-authored** record at any scope but the actor's own, the storage half of
  `memoryWriteVerdict`'s third rule. A human-authored one above it is allowed: that is what a console
  publishing an organisation's policy does, and whether that person may write there needs facts a
  provider is not handed.
- `pin({ id, pinned })` is the operator act the SPI has no method for. A pin grants a fact a permanent
  place in every future prompt, so nothing an agent can reach may set it.

**`search` is not implemented**, for the same reason as the sibling adapter: it needs an index over
the memories themselves, whose shape depends entirely on what a deployment already runs, and without
it `list` reads the applicable scopes whole so the ceiling never bites. `MemoryDigest.omitted` going
non-zero — `pinnedOmitted` especially — is the signal that it is worth building.

`DrizzleAgentStoreModule.forRoot({ db })` exports the provider but never binds `AGENT_MEMORY`: that
token's presence is what turns memory on, so binding it would switch the feature on for every host
that installs the store. Name the provider in `AgentModule`'s `memory: { provider }` to opt in.
