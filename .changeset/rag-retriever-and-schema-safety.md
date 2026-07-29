---
'@dudousxd/nestjs-agent-rag': patch
'@dudousxd/nestjs-agent-rag-media': patch
---

**Three correctness fixes in RAG: a keyword index that could not forget a document, an ingestion size gate that trusted the caller, and a Redis schema check that ignored drift.**

**`KeywordRetriever` can now forget a document — `remove()`, `clear()`, `size`.**

The documented hybrid pattern feeds the same chunks to the vector store *and* the keyword index, but
only the vector store had a `remove`. `KeywordRetriever.remove` was private, so a consumer who
followed the docs and later deleted a document left it **lexically retrievable forever** — and since
`retrieve` returns `record.text` from the retriever's own copy, the deleted passage came back with its
full text. That is an exposure shape, not just staleness.

```ts
await store.remove(documentId); // vector half
keyword.remove(documentId); // ...and now the lexical half
```

`remove` collapses chunk ids the same way the vector stores do (`documentIdOf`, so `${id}#<n>`), spares
prefix-siblings, is a no-op on unknown ids, and keeps the BM25 corpus statistics exact — a retriever
you removed a document from scores identically to one that never indexed it.

**`ingestMediaFile` no longer trusts the caller-supplied `size`.**

`MediaAttachEvent.size` is declared upstream — in a real host it originates in the client's upload
session — but it was the *only* thing gating the read, and it was stamped into every chunk as the
fingerprint `reconcileMediaRag` later compares. A client declaring `size: 0` therefore walked past the
limit into an embedding batch, and every chunk then claimed 0 bytes, so the reconciler's fingerprint
was permanently wrong.

The declared value may now only ever *reject* early (a cheap short-circuit); what authorizes the
ingest is the real `bytes.byteLength`, re-checked after the read and skipped as `too-large` if it
exceeds `maxBytes` — before extraction and embedding. Chunk metadata carries the real length.

New optional `statFile` dep — `(disk, path) => Promise<number>` (S3 `HeadObject`, `fs.stat`) — moves
the authoritative check *ahead* of the download, so an oversized object is never fetched at all.
`reconcileMediaRag` uses it too, keeping its fingerprint comparison real-vs-real; without it, a
declared size that disagrees with the bytes reads as drift and re-ingests once per pass.

**`RedisVectorStore.ensureSchema` now detects index drift instead of ignoring it.**

It was `try { FT.INFO } catch { create }` — if the index existed, *nothing* was compared. Adding a
`filterableFields` entry did nothing (no `meta_*` TAG was created, so every later search filtering on
it matched nothing), and changing `dimensions` did nothing (the index kept the old `DIM` and either
rejected vectors or ranked garbage). Both were silent.

`ensureSchema` now parses `FT.INFO`'s attributes and reacts by what is actually repairable:

- **a missing filterable TAG is additive** → repaired in place with `FT.ALTER … SCHEMA ADD`. Chunks
  written before the alter carry no `meta_*` hash field at all, so they become filterable on that key
  only once re-ingested — the schema is repaired here, the backfill stays the host's call.
- **a dimension or field-type change is not repairable** → throws the new exported
  `RedisVectorSchemaMismatchError` (carrying `index`, `field`, `expected`, `actual`). It needs a drop
  + full reindex, which would destroy the host's corpus.

An `FT.INFO` reply the parser doesn't recognise infers no drift, so an unreadable reply can't become a
false alarm that blocks a boot. Both wire shapes are handled (RESP2 flat arrays, RESP3 objects).

All additive: no existing signature changes.
