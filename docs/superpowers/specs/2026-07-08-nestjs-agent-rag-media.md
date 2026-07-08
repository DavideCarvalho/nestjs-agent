# `@dudousxd/nestjs-agent-rag-media` — media → RAG ingestion

**Goal:** Attach a file through `@dudousxd/nestjs-media` and it becomes searchable by the agent
automatically — extract text, chunk, embed, index — scoped to its owner, with delete kept in sync.

## Architecture

```
media.attach ──(aviary:media:attach)──▶ AgentMediaIngestionService
                                              │
   readFile(disk, path) ──▶ Buffer ──▶ TextExtractor ──▶ text
                                              │
                     chunk ──▶ embed ──▶ store.remove(mediaId) + upsert
                                              │
              metadata: { mediaId, ownerType, ownerId, collection, source }
media.delete ──(aviary:media:delete)──▶ store.remove(mediaId)
```

**Coupling via the diagnostics channel, not a package import.** The integration subscribes to
`channelName('media', 'attach' | 'delete')` (the same `node:diagnostics_channel` seam Telescope uses)
and takes an injected `readFile(disk, path) => Promise<Buffer>`. So `-rag-media` has **no hard
dependency on `@dudousxd/nestjs-media`** — it couples to the wire contract media already advertises.
The host wires the one line `readFile: (disk, path) => media.disk(disk).get(path)`.

**Owner comes from the server-side attach record** (`AttachPayload.ownerId`), never a client-supplied
key. Retrieval filters on that metadata for per-user / per-tenant RAG.

## Changes to `@dudousxd/nestjs-agent-rag` (canonical layer)

1. **`VectorStore.remove(documentId: string): Promise<void>`** — deletes every chunk whose id is
   `${documentId}#*`. Required on the SPI (pre-1.0, all shipped stores implement it). Motivated
   beyond media: it fixes a latent re-ingestion bug — re-ingesting a document that now produces
   *fewer* chunks leaves the old higher-index chunks orphaned, because `upsert` only overwrites
   matching ids. Implementations:
   - `MemoryVectorStore`: delete map keys starting with `${documentId}#`.
   - `PgVectorStore`: `DELETE FROM <table> WHERE id LIKE $1` with `${documentId}#%` (escape `%`/`_`).
   - `RedisVectorStore`: `SCAN` keys matching `${prefix}${documentId}#*` → `DEL`.

2. **`FilteredRetriever(base, filter)`** — a generic `Retriever → Retriever` combinator (same family
   as `HybridRetriever` / `RerankingRetriever`) that ANDs a fixed metadata `filter` into every
   `retrieve` call. The owner-scoping primitive: `new FilteredRetriever(base, { ownerId: actor.id })`.

## The `-rag-media` package

- **`TextExtractor`** SPI: `extract(bytes: Buffer, mimeType: string): Promise<string>`.
  - `MimeTextExtractor` — a registry dispatching by mime type, with a fallback.
  - `defaultTextExtractor()` — `text/*`, `application/json`, `text/csv`, `text/markdown` → UTF-8
    decode; `text/html` → tag-stripped text; anything else → throws `UnsupportedMimeTypeError`
    (ingestion skips it quietly rather than indexing binary garbage). PDF/DOCX are documented as
    optional add-on extractors (bring the parser), keeping `-rag` extraction-agnostic.
- **`ingestMediaFile(event, deps)`** — pure function: size-gate → `readFile` → `extract` →
  `store.remove(id)` → `chunkDocuments` (metadata `{ mediaId, ownerType, ownerId, collection }`,
  `source: path`) → `ingestChunks`. Returns chunk count. Exposed so a host can run it inside a
  durable workflow (both libs are durable-backed) if it wants; the module runs it inline.
- **`removeMedia(event, { store })`** — `store.remove(event.id)`.
- **`AgentMediaIngestionModule.forRoot(options)`** — provides `AgentMediaIngestionService`, which
  subscribes to the two channels on `onModuleInit` and unsubscribes on `onModuleDestroy`. Options:
  `{ collections?, readFile, embedder, store, extractor?, chunk?, maxBytes? }` (default `maxBytes`
  25 MB; empty/absent `collections` = all). Unsupported mime types debug-log and skip; real failures
  error-log; each success emits `aviary:rag:media.ingested` for Telescope.
- **`MediaAttachEvent` / `MediaDeleteEvent`** — the minimal payload shapes the integration reads,
  mirroring media's `AttachPayload` / `DeletePayload` (documented as the channel contract).

## Testing

- `-rag`: `remove` unit test on `MemoryVectorStore`; `remove` (incl. orphan-free re-ingest) in the
  Pg + Redis `*.db.spec.ts` (testcontainers). `FilteredRetriever` unit test.
- `-rag-media`: `TextExtractor` (each default type + unsupported throw); `ingestMediaFile` /
  `removeMedia` over a fake `readFile` + `FakeEmbeddingProvider` + `MemoryVectorStore`; the module
  end-to-end by `emit('media','attach', …)` on the real channel and asserting the doc is retrievable,
  then `emit('media','delete', …)` and asserting it's gone.

## Docs (aviary)

New `content/docs/agent/packages/rag-media.mdx` + a "Ingesting uploads" section in the RAG guide;
bump the agent lib `packages:` count in `lib/libs.ts` (14 → 15).
