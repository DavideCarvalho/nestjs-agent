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
DDL helper for a quick start), `DrizzleAgentStore`, `DrizzleGovernanceQueries`, and
`DrizzleRagIngestionLog`. For production,
prefer your normal drizzle-kit migrations over the `ensureAgentSchema` helper.

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

`DrizzleMemoryProvider` is a `MemoryProvider` over `agent_memory`, a table `ensureAgentSchema`
creates alongside the other six.

```ts
import { DrizzleAgentStoreModule, DrizzleMemoryProvider } from '@dudousxd/nestjs-agent-store-drizzle';

AgentModule.forRootAsync({
  // AGENT_STORE already comes from DrizzleAgentStoreModule.forRoot({ db }), which is global.
  externalStore: true,
  inject: [DrizzleMemoryProvider],
  useFactory: (memory: DrizzleMemoryProvider) => ({
    model,
    actorResolver,
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
  same key at once cannot race to a duplicate-key insert. The conflict `set` names exactly what a
  rewrite may change, so `pinned`, `created_at` and `id` are left alone by construction: a rewrite
  must not unpin a record, lose when the belief was formed, or invalidate the delete handle a person
  was already shown.
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
ALTER TABLE agent_run ADD COLUMN parent_run_id TEXT;
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

## RAG ingestion outcomes

`rag_ingestion_log` holds the latest outcome for every RAG document — ingested, skipped, failed,
removed — one row per document id, overwritten on re-ingest. It answers the question a vector store
structurally cannot: *which documents failed to index, and why*. A document whose extraction came
back empty, whose mime type had no extractor, or whose embedding call threw produces zero chunks, so
`VectorStore.listDocuments()` cannot tell it from one nobody ever uploaded. Pair the two: the index
is the truth about what is retrievable, this table is the truth about what was attempted.

`DrizzleRagIngestionLog` fills it by subscribing to the `aviary:rag:*` diagnostics
`@dudousxd/nestjs-agent-rag-media` publishes — the RAG package owns no storage of its own. It is
bound and exported by `DrizzleAgentStoreModule.forRoot({ db })` by default; pass
`{ ragIngestionLog: false }` to bind nothing at all. `ensureAgentSchema` creates the table, indexed
by (`collection`, `updated_at`) for the per-collection listing.

Reads: `list` / `listPage` (a page plus the unpaginated total), `get`, `remove`,
`removeByCollection`, a delete-safe keyset `iterate`, and `listDocumentIds` for an orphan sweep that
wants a collection's id set without hydrating every stack trace in the table. The paging order is
exported as `RAG_INGESTION_LOG_PAGE_ORDER` — `updated_at desc` tiebroken on the primary key, which
is what keeps consecutive pages disjoint when a bulk upload stamps a whole batch with one timestamp.

Writes are best-effort: the recorder runs detached on a diagnostics channel, so a failed write is
reported and dropped rather than taking down the ingestion that triggered it.

## Cost accounting

`DrizzleGovernanceQueries` resolves cost per usage row as `COALESCE(reportedCostUsd, tokens × pricing)`:
a gateway-reported `costUsd` wins when present, otherwise a cache-aware estimate against the current
`agent_model_pricing` row (cache-write/read tokens priced at their own nullable rates, falling back to
the input rate). See the [root README](https://github.com/DavideCarvalho/nestjs-agent#cost--governance)
for the full model.

## License

MIT © Davide Carvalho
