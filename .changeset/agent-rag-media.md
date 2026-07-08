---
"@dudousxd/nestjs-agent-rag-media": minor
"@dudousxd/nestjs-agent-rag": minor
---

Auto-ingest media uploads into RAG — a new `@dudousxd/nestjs-agent-rag-media` package.

Attach a file through `@dudousxd/nestjs-media` and it becomes searchable by the agent automatically:
`AgentMediaIngestionModule.forRoot({ store, embedder, readFile, collections })` subscribes to the
`aviary:media:attach` / `aviary:media:delete` diagnostics channels, extracts text, chunks, embeds,
and indexes each file — scoped to its owner from the server-side attach record — and drops the chunks
again on delete. It couples to the media library through the diagnostics channel (the same seam
Telescope rides), so there is **no hard dependency on `@dudousxd/nestjs-media`**: the host supplies a
one-line `readFile: (disk, path) => media.disk(disk).get(path)`.

- **`TextExtractor`** SPI + `defaultTextExtractor()` (text/\*, JSON, HTML) — pluggable per mime type,
  so PDF/DOCX are a `.register('application/pdf', parser)` away and `-rag` stays format-agnostic.
- **`ingestMediaFile` / `removeMedia`** — the pure ingest/remove functions, exposed so a host can run
  ingestion inside a durable workflow if it wants.
- **`reconcileMediaRag(query, deps)`** — drift repair. Diffs a `MediaSource` (the media records for an
  owner/collection, your source of truth) against what's indexed, then ingests what's missing,
  re-ingests what changed (the indexed `size` fingerprint no longer matches), and removes orphans.
  Fixes the gap events can't cover — a subscriber that was down, a record deleted straight in the DB,
  or a file replaced while nobody was listening. Safe to run on a schedule or at boot; only touches
  the difference.
- **`enqueue` hook + `applyMediaIngestJob(job, deps)`** — opt-in at-least-once. Set `enqueue` and
  attach/delete are handed to your durable queue instead of ingested inline; the worker calls
  `applyMediaIngestJob`. Keeps durable optional — the package pulls in no durable dependency.
- **Conversion ingestion** — `conversions: { names, resolve }` subscribes to `aviary:media:conversion`
  and ingests server-side derived artifacts (PDF→text, OCR) under the original's document id, so heavy
  extraction is offloaded to the media pipeline and delete-sync still covers it. `resolve` maps the
  bare conversion event back to an ingestable descriptor (owner/collection/disk from the record).
- Emits `aviary:rag:media.*` diagnostics for observability.

`@dudousxd/nestjs-agent-rag` gains three supporting pieces:

- **`VectorStore.remove(documentId)`** — deletes every chunk of a document (`${id}#*`). Implemented
  on all three stores (Memory / pgvector `DELETE … LIKE` / Redis `SCAN`+`DEL`). Beyond delete-sync it
  fixes a latent bug: re-ingesting a document that now yields *fewer* chunks used to leave the old
  tail orphaned, because `upsert` only overwrites matching ids.
- **`VectorStore.listDocuments(filter?)`** — enumerates the distinct source documents indexed (chunk
  ids collapsed via the new `documentIdOf` helper), each with a representative chunk's `metadata`,
  optionally metadata-filtered. The enumeration seam reconciliation diffs against (it reads back the
  `size` fingerprint). Implemented on all three stores (Memory / pgvector `SELECT DISTINCT ON` / Redis
  paginated `FT.SEARCH … RETURN`).
- **`FilteredRetriever(base, filter)`** — a generic retriever combinator that ANDs a fixed metadata
  filter into every query. The owner/tenant-scoping primitive: `new FilteredRetriever(base, { ownerId })`.
