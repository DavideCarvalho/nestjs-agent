# `@dudousxd/nestjs-agent-store-mikro-orm`

> 🪺 Part of the [Aviary](https://davidecarvalho.github.io/aviary) · a persistence adapter for [`@dudousxd/nestjs-agent`](https://www.npmjs.com/package/@dudousxd/nestjs-agent).

MikroORM persistence for the agent — threads, messages, tool calls, token usage, and model pricing.
Implements the `AgentStore` SPI and binds it to the `AGENT_STORE` token.

## Install

```bash
pnpm add @dudousxd/nestjs-agent-store-mikro-orm @mikro-orm/core @mikro-orm/nestjs
```

## Use

```ts
import { MikroOrmAgentStoreModule } from '@dudousxd/nestjs-agent-store-mikro-orm';

@Module({
  imports: [
    MikroOrmModule.forRoot(/* your config */),
    MikroOrmAgentStoreModule.forFeature(), // registers the agent entities + binds AGENT_STORE
    AgentModule.forRoot({ /* store comes from AGENT_STORE */ model, modelId, store }),
  ],
})
export class AppModule {}
```

The package ships the entities (`EntitySchema`) and `MikroOrmAgentStore`. Run your normal MikroORM
migrations to create the tables, or use the exported schema helper for a quick start.

Upgrading from a release before reasoning was persisted: `agent_message` gained three nullable
columns — `reasoning` (text), `reasoning_ms` (integer) and `ui` (json). `ensureAgentSchema` adds them
on boot; on your own migrations, `migration:create` picks them up from the entity diff, or write them
by hand:

```sql
alter table agent_message add column reasoning text null;
alter table agent_message add column reasoning_ms integer null;
alter table agent_message add column ui json null;
```

Upgrading from a release before message feedback: `agent_message` gained a nullable `feedback`
(json) column. `ensureAgentSchema` adds it on boot; `migration:create` picks it up from the entity
diff, or by hand: `alter table agent_message add column feedback json null;`

Upgrading from a release before per-thread models: `agent_thread` gained a nullable `model`
(varchar) column, added the same ways: `alter table agent_thread add column model varchar(255) null;`

Upgrading from a release before approval policies: `agent_tool_call` gained four nullable columns —
`approver` (varchar), `expires_at` (datetime), `remember` (boolean) and `decided_via` (varchar).
`ensureAgentSchema` adds them on boot; `migration:create` picks them up from the entity diff, or by
hand (adjust the types to your dialect):

```sql
alter table agent_tool_call add column approver varchar(255) null;
alter table agent_tool_call add column expires_at datetime null;
alter table agent_tool_call add column remember boolean null;
alter table agent_tool_call add column decided_via varchar(255) null;
```

Upgrading to the release that ran this store on real Postgres and MySQL (rather than SQLite only):

- `agent_message` gains a nullable `seq` (integer) — each message's place in its thread, assigned on
  append, which is now what orders a transcript. `created_at` could not: two messages of one turn
  share a timestamp, and the random uuid that broke the tie read them back swapped. Rows from before
  have no `seq` and sort first, in `created_at` order, as before.
- `agent_tool_call` declares its `message_id` index. MikroORM indexes a many-to-one for you on MySQL
  and SQLite — so nothing changes there — but not on Postgres, which gains the index.
- **MySQL only:** every timestamp becomes `datetime(6)` (MikroORM's bare `datetime` is whole seconds);
  the long text columns (`content`, `reasoning`, errors, memory text, stream frames) become `longtext`
  (`text` stops at 64 KB and the insert fails past it); and the identity columns (`actor_ref`,
  `tenant_ref`, `agent_memory.scope`/`origin_actor_ref`) take the binary collation of your charset
  (`utf8mb4_bin`), because under `utf8mb4_unicode_ci` two actors whose refs differed only in case
  listed each other's threads. Postgres and SQLite already behaved this way and see no change.

`ensureAgentSchema` applies all of it on the first boot after the upgrade. On MySQL those `modify`
statements rebuild `agent_message`, `agent_tool_call` and friends (a table copy each): on a large
deployment, run them in a maintenance window instead: boot with
`MikroOrmAgentStoreModule.forFeature({ autoSchema: false })`, and call `ensureAgentSchema(orm)` from a
one-off script when it suits you — it is the same heal, run once.

## The read a turn makes

The agent loop does not call `getThread` to build a prompt. This store implements the core SPI's
`ThreadTurnReader`, so the loop asks it for `loadThreadForTurn({ threadId, messageLimit })` instead:
the thread's newest `messageLimit` messages oldest-first, bounded by the database rather than in
memory, projected to the columns a model turn reads (`usage`, `follow_ups` and `run_id` stay in the
table), plus the title, the default agent, and whether the thread has EVER been answered.

`messageLimit` is the configured `HistoryPolicy.maxMessages`. A policy that summarizes, or whose
ceiling is only a token budget, names no row bound and the whole thread is read — see the core
README. Nothing to wire: the loop probes for the method, and `getThread` remains the right read for
a client rendering a transcript.

## Memory

`MikroOrmMemoryProvider` is a `MemoryProvider` over `agent_memory` — a table this package owns and
heals at boot, alongside every other `agent_*` table, so it is in `agentManagedTables()` and your
migration differ must skip it like the rest.

```ts
import {
  MikroOrmAgentStoreModule,
  MikroOrmMemoryProvider,
} from '@dudousxd/nestjs-agent-store-mikro-orm';

AgentModule.forRootAsync({
  // No `store`: AgentModule finds the AGENT_STORE MikroOrmAgentStoreModule.forFeature() binds.
  inject: [MikroOrmMemoryProvider],
  useFactory: (memory: MikroOrmMemoryProvider) => ({
    model,
    memory: { provider: memory },
  }),
});
```

The store module exports the provider but never binds `AGENT_MEMORY`: that token's **presence** is
what turns memory on, so binding it here would switch the feature on for every host that installs the
store. Naming the provider is how you opt in.

What it holds to:

- `list` filters `scope in (…)` in the **query**. The library drops out-of-scope records it is handed,
  but that is a backstop — a memory held for another actor or another tenant is never selected, so it
  is unreachable rather than outranked.
- `write` upserts on the (`scope`, `key`) unique index in one statement, so two turns concluding the
  same key at once cannot race to a duplicate-key insert. `pinned`, `created_at` and `id` are excluded
  from the conflict merge: a rewrite must not unpin a record, lose when the belief was formed, or
  invalidate the delete handle a person was already shown.
- `write` refuses an **agent-authored** record at any scope but the actor's own. A human-authored one
  above it is allowed, because that is what a console publishing an organisation's policy does, and
  whether that person may write there is what `memoryWriteVerdict` answers.
- `forget` deletes only from the actor's own scope, so an id alone cannot reach a tenant's memory.
- `pin({ id, pinned })` is the operator act the SPI has no method for — a pin grants a fact a
  permanent place in every future prompt, so nothing an agent can reach may set it. Authorize it in
  your own console.

**`search` is not implemented**, deliberately. It buys a block filled by relevance once the applicable
set outgrows `maxMemories`, and that needs an index over the memories themselves — whose shape depends
entirely on what you already run. Without it, `list` reads the applicable scopes whole and the ceiling
never bites. The signal that it is worth building is `MemoryDigest.omitted` going non-zero, and
`pinnedOmitted` especially: a standing policy that stopped reaching any prompt. Both are on the
`aviary:agent:memory.resolved` diagnostic.

## Attachment housekeeping

`referencedMediaIds(actorRef, mediaIds)` answers which of a set of media ids a message that still
exists — or one still waiting in a thread's queue (`agent_queued_message`) — carries, for one actor — the inverse of the host's own staged-media inventory, and the half a
sweep cannot work out for itself. It needs **no schema change**: it reads the `attachments` JSON
column messages have carried since attachments shipped, so an existing database answers correctly
the moment you upgrade, with nothing to backfill and no `ensureAgentSchema` heal to wait on — so the
dialect-dependent add-column heal (which does not reach SQLite) is not in the path.

The match happens in memory rather than in SQL. The column holds an array of objects, every dialect
spells that query differently, and none of them can use an index for it; the scan is bounded to one
actor's attachment-bearing messages, and a message with no attachments never leaves the database.

A thread that was soft-deleted still counts as holding its references: the message rows survive, so
the bytes are still reachable from stored state. Delete the thread for real and the cascade makes
them collectable on the next sweep.

## RAG ingestion outcomes

`rag_ingestion_log` holds the latest outcome for every RAG document — ingested, skipped, failed,
removed — one row per document id, overwritten on re-ingest. It answers the question a vector store
structurally cannot: *which documents failed to index, and why*. A document whose extraction came
back empty, whose mime type had no extractor, or whose embedding call threw produces zero chunks, so
`VectorStore.listDocuments()` cannot tell it from one nobody ever uploaded. Pair the two: the index
is the truth about what is retrievable, this table is the truth about what was attempted.

`MikroOrmRagIngestionLog` fills it by subscribing to the `aviary:rag:*` diagnostics
`@dudousxd/nestjs-agent-rag-media` publishes — the RAG package owns no storage of its own. It is
bound and exported by `MikroOrmAgentStoreModule.forFeature()` by default; pass
`{ ragIngestionLog: false }` to bind nothing at all. The boot `ensureAgentSchema` heal creates and
maintains the table, indexed by (`collection`, `updated_at`) for the per-collection listing.

Reads: `list` / `listPage` (a page plus the unpaginated total), `get`, `remove`,
`removeByCollection`, a delete-safe keyset `iterate`, and `listDocumentIds` for an orphan sweep that
wants a collection's id set without hydrating every stack trace in the table. The paging order is
exported as `RAG_INGESTION_LOG_PAGE_ORDER` — `updated_at desc` tiebroken on the primary key, which
is what keeps consecutive pages disjoint when a bulk upload stamps a whole batch with one timestamp.

Writes are best-effort: the recorder runs detached on a diagnostics channel, so a failed write is
reported and dropped rather than taking down the ingestion that triggered it.

## License

MIT © Davide Carvalho
