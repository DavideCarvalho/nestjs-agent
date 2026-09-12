---
'@dudousxd/nestjs-agent-store-drizzle': minor
---

The RAG ingestion ledger is no longer something only the MikroORM adapter can keep.

`rag_ingestion_log` records the outcome of every RAG ingestion — ingested, skipped, failed, removed
— and it is the only place a document that produced **no chunks** is visible at all. A scanned PDF
whose extraction came back empty, a mime type with no extractor, an embedding call that blew up:
each produces zero chunks, so `VectorStore.listDocuments()` cannot tell any of them from a document
nobody ever uploaded. Until now that table existed for `store-mikro-orm` only, so choosing Drizzle
silently decided that a deployment could not audit its own ingestions.

`@dudousxd/nestjs-agent-rag` owns no storage here and never did: it publishes `aviary:rag:*`
diagnostics, and a store *subscribes*. This release adds the Drizzle subscriber:

- `ragIngestionLog` in `agentSchema`, created by `ensureAgentSchema` and indexed by
  (`collection`, `updated_at`) for the per-collection listing.
- `DrizzleRagIngestionLog` — the recorder. Upserts on the document id, so the row is the document's
  *current* state: a successful retry overwrites the failure it replaces instead of leaving a stale
  error beside a working document, and `created_at` survives, so a row still answers "when was this
  first attempted?". A sparser later event (`removed` knows the owner but not the collection) leaves
  what an earlier event recorded alone. Writes are best-effort and never throw — this runs detached
  on a diagnostics channel, so a failed write is reported and dropped rather than taking down the
  ingestion that triggered it.
- The read path a console needs: `list`, `listPage` (page plus the unpaginated total), `get`,
  `remove`, `removeByCollection`, the delete-safe keyset `iterate`, and `listDocumentIds` for an
  orphan sweep that wants a collection's id set and not every stack trace in the table.
  `RAG_INGESTION_LOG_PAGE_ORDER` is exported because the order is a contract: `updated_at desc`
  tiebroken on the primary key, which is what keeps consecutive pages disjoint when a bulk upload
  stamps a whole batch with one timestamp.

`DrizzleAgentStoreModule.forRoot({ db })` binds and exports it by default, the same as
`MikroOrmAgentStoreModule.forFeature()` — a default of off would have left the gap this closes
open for anyone who did not know to look for the switch. `{ ragIngestionLog: false }` binds nothing
at all, for a host that records outcomes itself or ingests no media. The table has to exist:
`ensureAgentSchema` creates it, or write the `CREATE TABLE` into your own migrations.

**Upgrading an existing Drizzle database.** Nothing to do beyond running `ensureAgentSchema`, which
is where a new table belongs rather than in the add-column pass: `CREATE TABLE IF NOT EXISTS` is
only inert against a database that already has the table, and no database has this one, so it is
created in full — every column and its index — on a database of any age.

Both adapters' suites now assert the same behaviours in the same words, and the MikroORM side picks
up the four its sibling exposed as untested: `created_at` surviving an upsert, the recorder going
quiet once torn down, a page total that counts the filter rather than the page, and a write failure
being reported instead of escaping.
