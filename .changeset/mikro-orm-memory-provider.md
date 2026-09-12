---
'@dudousxd/nestjs-agent-store-mikro-orm': minor
---

The library now owns the memory table: `agent_memory`, plus `MikroOrmMemoryProvider` over it.

**This reverses a deliberate omission, so here is why.** `agentManagedTables()` listed seven tables
and no memory one, on the same reasoning `skills.ts` gives for owning no skill table: the axes a
deployment scopes by, the console that edits the rows and the audit trail are the host's, and a table
this package creates at boot puts a consumer's migrations in the path of the schema heal.

Two of those three do not hold for memory, and the third is the argument for `agentManagedTables()`
rather than against the table:

- **There is nothing for a host to relate to.** A skill row plausibly joins a host's own entities —
  who authored it, which sector it belongs to, which review approved it. A memory row is a key, a
  fact, an opaque scope token and an origin. The scope is opaque *by construction*, so a `varchar`
  holds every axis any deployment will ever mint.
- **The console stays the host's.** The read-back and the delete are already this library's
  (`GET /agent/memories`, `DELETE /agent/memories/:id`), and a host's own console reads the rows
  through the provider either way. Owning the storage takes nothing away.
- **The migration argument is what `agentManagedTables()` is for.** It is the same argument that
  applies to `agent_thread` and `rag_ingestion_log`, and the answer is the denylist this package has
  always exported. `agent_memory` is in it.

What made memory the odd one out is that every other part of it was already here. A skill's body is
authored by a person, through a UI the host builds. A memory is written by the agent, through this
library's `remember` tool, served by this library's `writeMemory`, resolved by its `memory:digest`
checkpoint and read back over its own endpoint. Storage was the only half missing — which is why two
applications on this platform wrote the same table before this landed.

`MikroOrmMemoryProvider` implements `list`, `write` and `forget`:

- `list` filters `scope in (…)` in the query, against the leading column of the (`scope`, `key`)
  unique index. The library drops out-of-scope records it is handed, but that is a backstop: a memory
  held for another actor or another tenant is never selected, so it is unreachable rather than
  outranked.
- `write` upserts on that unique index in one statement — two turns concluding the same key at once
  would otherwise race to a duplicate-key insert and fail one `remember` call. `pinned`, `created_at`
  and `id` are excluded from the conflict merge: a rewrite must not silently unpin the row, lose when
  the belief was first formed, or invalidate the delete handle a person was already shown.
- `write` refuses an **agent-authored** record at any scope but the actor's own, which is the storage
  half of `memoryWriteVerdict`'s third rule. A human-authored one above it is allowed, because that is
  what a console publishing an organisation's policy does, and whether that person may write there
  needs facts a provider is not handed (`ScopeContext` carries no resolved scope list and no
  elevation).
- `forget` puts the actor's own scope in the `where`, so an id alone cannot reach a tenant's or the
  deployment's memory. "No such id" and "not yours" answer identically.
- `pin({ id, pinned })` is the operator act the SPI has no method for. A pin grants a fact a permanent
  place in every future prompt, so nothing an agent can reach may set it; this takes no
  `ScopeContext` because it is not an actor's act on their own memory, and a host authorizes it in its
  own console.

**`search` is not implemented**, and that is a decision. It buys a block filled by relevance once the
applicable set outgrows `maxMemories`, and that needs an index over the memories themselves — whose
shape depends entirely on what a deployment already runs (pgvector, a full-text index, a hybrid
service). Picking one here would make this adapter require infrastructure most hosts do not have, for
a ceiling most of them never reach: without `search`, `list` reads the applicable scopes whole and
the ceiling never bites. The signal that it is worth building is `MemoryDigest.omitted` going
non-zero — and `pinnedOmitted` especially, which means a standing policy stopped reaching any prompt.
Both are on the `aviary:agent:memory.resolved` diagnostic.

**Upgrading.** The new entity changes the schema fingerprint, so the next boot heals the table in
(`create table` + `create unique index`, additive as ever). A host that manages these tables with its
own migrations instead (`autoSchema: false`) gets the DDL from `agentSchemaSql()` like the rest, and
should add `agent_memory` to whatever its differ skips — `agentManagedTables()` already names it.
`MikroOrmAgentStoreModule.forFeature()` exports the provider but never binds `AGENT_MEMORY`: that
token's presence is what turns memory on, so binding it would switch the feature on for every host
that installs the store. Name the provider in `AgentModule`'s `memory: { provider }` to opt in.
