# @dudousxd/nestjs-agent-rag

## 0.6.0

### Minor Changes

- [#48](https://github.com/DavideCarvalho/nestjs-agent/pull/48) [`740c916`](https://github.com/DavideCarvalho/nestjs-agent/commit/740c916fcd74de3cbc0cb4133d735a936b50286d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - RAG: change a document's metadata without re-embedding it.

  `VectorStore` could `upsert` (which needs the text and a fresh embedding) and `remove` — so a
  consumer whose documents get re-classified had to either re-embed a whole document to change a
  string, or refuse to stamp the mutable dimension onto chunks at all and resolve it at query time
  instead, turning a filter the index could apply into a join the caller has to.

  New `updateMetadata(documentId, patch): Promise<number>` rewrites the metadata of every chunk of a
  document and touches neither its text nor its embeddings, returning the number of chunks written.
  The patch is a shallow JSON Merge Patch (RFC 7386): keys absent from it keep their stored value,
  `null` removes a key, `undefined` is ignored (it does not survive a JSON hop, and it is what a spread
  produces by accident), and values — arrays above all — are replaced wholesale, since an array-valued
  key is a set-valued dimension. An unknown document id returns `0` rather than throwing, matching
  `remove`: this is a reconciliation-shaped call that races with ingestion by construction.

  Implemented for all three shipped adapters. In `RedisVectorStore` the point of care is that metadata
  is stored **twice** — as `meta_<field>` TAGs (what RediSearch filters on) and as a `metadata_json`
  blob (what comes back on a `Passage`) — so the update rewrites both from the same merged object and
  `HDEL`s the TAG of a removed key; updating one and not the other would leave a chunk that filters as
  one value but reports another. Also exports `applyMetadataPatch` so a custom `VectorStore` can
  implement the same semantics.

- [#47](https://github.com/DavideCarvalho/nestjs-agent/pull/47) [`16021d0`](https://github.com/DavideCarvalho/nestjs-agent/commit/16021d0230407c553b0f4a7af907963b5a205e37) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - RAG stores: targeted enumeration and bulk deletion, so collection maintenance stops costing a full keyspace pass per document.

  Four new **required** members of `VectorStore`, implemented by all three shipped adapters:

  - `listDocumentIds(filter?)` — the distinct document ids, without fetching or JSON-parsing a metadata blob per chunk (`FT.SEARCH … NOCONTENT` / `SELECT DISTINCT`).
  - `removeMany(documentIds)` — N documents in one pass instead of N independent ones.
  - `removeWhere(filter)` — delete a whole scope with one filtered query, resolving the number of chunks removed. No keyspace scan on Redis.
  - `countChunks(filter?)` — a counted query (`FT.SEARCH … LIMIT 0 0` / `count(*)`), no chunks transferred.

  **Breaking for anyone who wrote their own `VectorStore`:** a store implementing only the previous five members no longer satisfies the interface and will not compile until the four methods are added. That is deliberate, and it is why this did not ship as an optional capability interface. These are CRUD over records the store already holds — the same footing as `remove` and `listDocuments` — so making them optional would have bought every _consumer_ a permanent `if (isEnumerableVectorStore(store))` plus an unreachable "and if it isn't?" branch, forever, to protect a case that does not exist: this package is 0.x, all three adapters are in-tree, and there are no known external implementations. It stays a **minor** accordingly.

  `LexicalVectorStore.searchText` stays optional, and the `VectorStore` doc comment now records the rule that separates the two: required when every backend _can_ do it from what it already stores; optional only when some backend genuinely cannot without infrastructure the consumer has to adopt (Postgres would need a `tsvector` column, a GIN index and a migration; `MemoryVectorStore` would have to implement BM25 itself).

  `removeWhere` honours the package's empty-array **deny** primitive: `removeWhere({ audience: [] })` deletes nothing and returns `0`, and a deny ANDed with a matching scope still denies. An empty filter object (`removeWhere({})`) throws the new `UnsafeRemovalError` instead of wiping the store — deliberate mass deletion stays available as `removeMany(await store.listDocumentIds())`. On Redis, a filter key with no declared `meta_*` TAG throws rather than being handed to the engine.

  `VectorStore.remove` is unchanged. Making it index-backed would require stamping the document id at write time, and chunks written before that change would become undeletable without any error — the new methods deliver the asymptotic win with no migration.

## 0.5.0

### Minor Changes

- [#40](https://github.com/DavideCarvalho/nestjs-agent/pull/40) [`edec68a`](https://github.com/DavideCarvalho/nestjs-agent/commit/edec68a3e7cb891df60a228ec7cc4f0da0c4f3e2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Store-backed lexical retrieval: hybrid search without an in-process keyword index

  `KeywordRetriever` is in-memory and per-process, so it only works where ingestion and search share a
  process. A deployment that ingests on a worker and searches on an API pod has no way to build it on
  the search side — the API process never sees the chunks — and ends up scanning the whole corpus into
  JS heap on every pod just to have something to rank.

  It never needed to. `RedisVectorStore` already declares the chunk text as a RediSearch `TEXT` field,
  so the lexical index has been sitting in the same index as the vectors all along, unused.

  - **`LexicalVectorStore`** — an optional capability interface a `VectorStore` may also implement,
    plus an `isLexicalVectorStore(store)` type guard so callers can detect it.
  - **`RedisVectorStore.searchText(query, options)`** — BM25 over the existing index, reusing the same
    filter/tag-escaping code as `search`, including the empty-array deny primitive. Scorer is
    configurable via the new `lexicalScorer` option (default `BM25`).
  - **`LexicalRetriever(store)`** — the core `Retriever` for that capability, so
    `new HybridRetriever([new EmbeddingRetriever(embedder, store), new LexicalRetriever(store)])`
    composes with no other change. `HybridRetriever` fuses by RRF, which is rank-based, so BM25 and
    cosine need no common scale.

  Consequences: no second index to build, feed or mirror deletes into; no corpus in JS heap; and a
  document is lexically findable the moment it is upserted, with no refresh window.

  Queries are reduced to letter/digit/`_` terms before being sent, so RediSearch syntax in user input
  (`*`, `@field:{…}`, `|`, `-`, `=>[KNN …]`) is inert rather than escaped-but-live and cannot widen the
  filter it is ANDed with — the filter is routinely an ACL boundary. A query with no searchable terms
  left (empty, whitespace, punctuation-only) returns `[]` rather than matching the corpus.

  `PgVectorStore` deliberately does **not** implement this: its chunks table indexes nothing lexically,
  and adding a GIN index means boot-time DDL that locks an already-populated table plus a text-search
  configuration that silently degrades to a sequential scan when it disagrees with the query. That
  wants a migration a consumer runs and observes. The interface is open for it later.

  `KeywordRetriever` is neither replaced nor deprecated by this — it remains the right answer for
  `MemoryVectorStore`, for a store with no lexical capability, and for single-process deployments. This
  is an additional path alongside it. (Where you do keep it, its own index still has to be fed and, as
  of the `remove()`/`clear()` fix shipping in this same release, explicitly emptied on delete. The
  store-backed leg has nothing to feed or empty, which is the point of it.)

## 0.4.1

### Patch Changes

- [#39](https://github.com/DavideCarvalho/nestjs-agent/pull/39) [`5eec114`](https://github.com/DavideCarvalho/nestjs-agent/commit/5eec1144d267066993225ec99c72a2c24176a302) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **Three correctness fixes in RAG: a keyword index that could not forget a document, an ingestion size gate that trusted the caller, and a Redis schema check that ignored drift.**

  **`KeywordRetriever` can now forget a document — `remove()`, `clear()`, `size`.**

  The documented hybrid pattern feeds the same chunks to the vector store _and_ the keyword index, but
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
  session — but it was the _only_ thing gating the read, and it was stamped into every chunk as the
  fingerprint `reconcileMediaRag` later compares. A client declaring `size: 0` therefore walked past the
  limit into an embedding batch, and every chunk then claimed 0 bytes, so the reconciler's fingerprint
  was permanently wrong.

  The declared value may now only ever _reject_ early (a cheap short-circuit); what authorizes the
  ingest is the real `bytes.byteLength`, re-checked after the read and skipped as `too-large` if it
  exceeds `maxBytes` — before extraction and embedding. Chunk metadata carries the real length.

  New optional `statFile` dep — `(disk, path) => Promise<number>` (S3 `HeadObject`, `fs.stat`) — moves
  the authoritative check _ahead_ of the download, so an oversized object is never fetched at all.
  `reconcileMediaRag` uses it too, keeping its fingerprint comparison real-vs-real; without it, a
  declared size that disagrees with the bytes reads as drift and re-ingests once per pass.

  **`RedisVectorStore.ensureSchema` now detects index drift instead of ignoring it.**

  It was `try { FT.INFO } catch { create }` — if the index existed, _nothing_ was compared. Adding a
  `filterableFields` entry did nothing (no `meta_*` TAG was created, so every later search filtering on
  it matched nothing), and changing `dimensions` did nothing (the index kept the old `DIM` and either
  rejected vectors or ranked garbage). Both were silent.

  `ensureSchema` now parses `FT.INFO`'s attributes and reacts by what is actually repairable:

  - **a missing filterable TAG is additive** → repaired in place with `FT.ALTER … SCHEMA ADD`. Chunks
    written before the alter carry no `meta_*` hash field at all, so they become filterable on that key
    only once re-ingested — the schema is repaired here, the backfill stays the host's call.
  - **a dimension or field-type change is not repairable** → throws the new exported
    `RedisVectorSchemaMismatchError` (carrying `index`, `field`, `expected`, `actual`). It needs a drop
    - full reindex, which would destroy the host's corpus.

  An `FT.INFO` reply the parser doesn't recognise infers no drift, so an unreadable reply can't become a
  false alarm that blocks a boot. Both wire shapes are handled (RESP2 flat arrays, RESP3 objects).

  All additive: no existing signature changes.

## 0.4.0

### Minor Changes

- [`bd5b15c`](https://github.com/DavideCarvalho/nestjs-agent/commit/bd5b15cc7db3375d54ba41acbf159a28292f0c50) - Metadata filters now accept **array values** as a **match-any** (OR / set-membership) predicate, in
  addition to the existing scalar exact-match. A record matches an array-valued filter key when its
  metadata value for that key is one of the array's elements — or, for a multi-valued record, shares
  at least one element with it. An empty array matches nothing (the deny primitive). Scalar filter
  values are unchanged, so this is backward compatible.

  This is the capability-token access-control primitive: give each document an opaque `audience` tag
  (e.g. `['public']`, `['role:ADMIN']`, `['base:…']`) and pass the caller's token set as the filter
  (`{ audience: ['public', 'role:ADMIN', 'base:…'] }`) — the store returns only documents the caller
  is entitled to, without ever knowing what a token means.

  Implemented across all three stores:

  - `MemoryVectorStore` / `KeywordRetriever` (`matchesFilter`) — membership/overlap.
  - `RedisVectorStore` — TAG alternation (`@meta_audience:{public|role\:ADMIN}`); array metadata is
    stored as a multi-valued TAG so a document can carry several tokens. Empty-array filters
    short-circuit to an empty result (RediSearch has no empty-tag syntax).
  - `PgVectorStore` — jsonb `?|` over the (array-normalized) metadata value; metadata keys are passed
    as query parameters so a caller-supplied key can't inject SQL.

## 0.3.10

### Patch Changes

- Updated dependencies [[`70114eb`](https://github.com/DavideCarvalho/nestjs-agent/commit/70114ebb9a7a3702d2efdb11e0dea6956a7ba8db)]:
  - @dudousxd/nestjs-agent-core@0.10.0

## 0.3.9

### Patch Changes

- Updated dependencies [[`107fcc2`](https://github.com/DavideCarvalho/nestjs-agent/commit/107fcc2c0079f97c3cc9ff8c83f2dc41070244d5)]:
  - @dudousxd/nestjs-agent-core@0.9.0

## 0.3.8

### Patch Changes

- Updated dependencies [[`3d256d4`](https://github.com/DavideCarvalho/nestjs-agent/commit/3d256d4027c7ad819f8ec908425d52887e67da3f)]:
  - @dudousxd/nestjs-agent-core@0.8.0

## 0.3.7

### Patch Changes

- Updated dependencies [[`6263338`](https://github.com/DavideCarvalho/nestjs-agent/commit/6263338cf86df7b51cb082d5d2d575987cd13383)]:
  - @dudousxd/nestjs-agent-core@0.7.0

## 0.3.6

### Patch Changes

- Updated dependencies [[`eb3aaff`](https://github.com/DavideCarvalho/nestjs-agent/commit/eb3aaff531cc923de1d0bccebb2b0690b4c92263), [`781a30f`](https://github.com/DavideCarvalho/nestjs-agent/commit/781a30f6579d5b9a69f341b8eeac02c273dbb8a1)]:
  - @dudousxd/nestjs-agent-core@0.6.0

## 0.3.5

### Patch Changes

- Updated dependencies [[`1c44152`](https://github.com/DavideCarvalho/nestjs-agent/commit/1c4415295a6280527e762f13e6aed48099ae5ca5), [`1c44152`](https://github.com/DavideCarvalho/nestjs-agent/commit/1c4415295a6280527e762f13e6aed48099ae5ca5)]:
  - @dudousxd/nestjs-agent-core@0.5.0

## 0.3.4

### Patch Changes

- Updated dependencies [[`abb32bc`](https://github.com/DavideCarvalho/nestjs-agent/commit/abb32bc0396c65a59ee2b92a1a8b07d772215e31)]:
  - @dudousxd/nestjs-agent-core@0.4.0

## 0.3.3

### Patch Changes

- Updated dependencies [[`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46), [`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46), [`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46)]:
  - @dudousxd/nestjs-agent-core@0.3.3

## 0.3.2

### Patch Changes

- Updated dependencies
- Updated dependencies [ad8e446]
  - @dudousxd/nestjs-agent-core@0.3.2

## 0.3.1

### Patch Changes

- Updated dependencies [[`60dcc7d`](https://github.com/DavideCarvalho/nestjs-agent/commit/60dcc7db3764a7d60cb6e4d586f1c0fe7b05ee04)]:
  - @dudousxd/nestjs-agent-core@0.3.1
