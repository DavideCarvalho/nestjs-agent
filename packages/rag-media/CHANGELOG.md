# @dudousxd/nestjs-agent-rag-media

## 0.6.1

### Patch Changes

- [`fe9fb99`](https://github.com/DavideCarvalho/nestjs-agent/commit/fe9fb9985131643ad9b2733a3c3658decdc585ab) - Add NestJS 12 to the supported peer range.

  Every `@nestjs/common`, `@nestjs/core` and `@nestjs/platform-express` peer that read
  `^10.0.0 || ^11.0.0` now reads `^10.0.0 || ^11.0.0 || ^12.0.0`. NestJS 12.0.1 shipped the framework
  as pure ESM and raised its floor to Node >= 20.19; these packages are already `"type": "module"`,
  so nothing needed porting — the turn loop, the `/api/agent/*` controllers, HITL approval as a durable
  signal, the stores and the dashboard all behave identically on 11 and 12.

  The dev and test matrix moved to the 12.x line with the ranges, including the demo app, so the added
  range is tested rather than merely declared: build, both typecheck passes, and the unit and
  database suites are green against 12.0.1.

  11 and 10 stay in every range. Nothing in the source depends on a 12-only API, so the widened range
  is additive and a consumer still on 11 sees no change.

## 0.6.0

### Minor Changes

- [#46](https://github.com/DavideCarvalho/nestjs-agent/pull/46) [`363e4cf`](https://github.com/DavideCarvalho/nestjs-agent/commit/363e4cfd48008ff4b1fbd894e0ed61f27c21069b) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - rag-media: make an ingestion failure branchable, so a host can tell "retry this" from "this will never work"

  `MediaIngestOutcome`'s failure arm was `{ status: 'failed'; error: string }` — the original error was stringified by `runMediaIngestJob`'s catch-all and thrown away. A host driving ingestion from a durable workflow could only re-throw blindly, so a permanently corrupt PDF was retried to exhaustion exactly like a transient S3 blip.

  The failed outcome now carries two more fields:

  ```ts
  { status: 'failed'; error: string; kind: MediaIngestFailureKind; cause?: unknown }
  ```

  - **`kind`** — which phase threw: `'read' | 'extract' | 'embed' | 'store' | 'unknown'`. `read` is the `statFile` probe and the `readFile` fetch; `extract` is `TextExtractor.extract` plus the chunking that follows it; `embed` is the `EmbeddingProvider`; `store` is the `VectorStore` (the pre-ingest `remove`, the final `upsert`, and delete-sync). Required, not optional — a consumer branching on a return type should not have to handle a fourth `undefined` case.
  - **`cause`** — the original thrown value, with its class and its own `cause` intact, so a host can apply its own retry policy (`cause instanceof ThrottlingException`) instead of parsing a message. **In-process only:** it rides the return value and the `aviary:rag:media.failed` publish by reference, and is deliberately absent from the persisted payload, because an `Error` JSON-stringifies to `{}`.

  Deliberately NOT a `retryable` boolean. Retryability depends on the underlying error _and_ host policy, not on the phase — a `read` failure is transient for an S3 5xx and permanent for a 404 — and every one of these deps is host-injected, so a library-emitted boolean would be a guess, with a wrong `retryable: false` silently dropping a document.

  Also additive:

  - `mediaIngestFailureKind(error)` — read the phase off a caught error, for callers that use `ingestMediaFile` / `applyMediaIngestJob` directly. Returns `'unknown'` for anything untagged, so it is total.
  - `RagMediaFailedPayload.kind?` — the phase on the `aviary:rag:media.failed` diagnostic, as a plain string that survives cloning and persistence. Optional here because the enqueue-failure path publishes when no phase ever ran.

  Nothing is wrapped or replaced: the phase is stamped onto the original error as a non-enumerable, globally-registered symbol (`Symbol.for('aviary.rag.media.ingestFailureKind')`) and the same object is re-thrown, so an existing `catch (e) { e instanceof S3Error }` keeps working and the tag cannot leak into a JSON log. `error` is unchanged, and the `unsupported-type` skip path is untouched.

## 0.5.2

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

## 0.5.1

### Patch Changes

- [#31](https://github.com/DavideCarvalho/nestjs-agent/pull/31) [`5332383`](https://github.com/DavideCarvalho/nestjs-agent/commit/533238300d9ef210b6af4fa4a2ba69f1eb8e3175) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `MimeTextExtractor` now normalizes registration keys the same way it already normalized lookups: media type only (the part before the first `;` per RFC 2045), trimmed and lowercased. Previously only the query side did this, so `.register('TEXT/*', fn)` and `.register('application/csv; charset=utf-8', fn)` stored a key that no normalized lookup could ever hit — a dead extractor that reports itself as an unsupported type, which ingestion records as a _skip_. The caller's own registration silently vanished and the documents disappeared with no error surfaced to the operator. The normalization rule is now a single exported helper, `normalizeMimeType`, shared by both sides so they can't drift apart again.

## 0.5.0

### Minor Changes

- [#24](https://github.com/DavideCarvalho/nestjs-agent/pull/24) [`287a720`](https://github.com/DavideCarvalho/nestjs-agent/commit/287a7209a1a89e540f237afd771c65d155601a5e) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `media.ingested` now carries the same outcome coordinates (`source`, `size`, `mimeType`) that `skipped` and `failed` already do. An attach event always carries a path/size/mime type, so the fields are required. Previously the ingestion-log recorder wrote `source`/`size`/`mimeType` = null for every SUCCESSFUL document — the one outcome whose payload lacked them — so consumers fell back to ugly document-id names and lost the file size.

## 0.4.0

### Minor Changes

- [#20](https://github.com/DavideCarvalho/nestjs-agent/pull/20) [`fc2981f`](https://github.com/DavideCarvalho/nestjs-agent/commit/fc2981f2ed56ddb46ed7adaa5ea1b65b35d9cbbe) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Make ingestion outcomes observable from outside the package.

  `skipped` and `failed` diagnostics now carry the owner/collection coordinates the `ingested` payload
  already had (via the new `RagMediaOutcomeContext` and the `outcomeContext(event)` helper), so a
  subscriber can attribute an outcome to the collection it belongs to instead of a bare media id.

  New `runMediaIngestJob(job, deps)`: `applyMediaIngestJob` with the error boundary attached. It never
  throws and returns a `MediaIngestOutcome` covering all four terminal states (`ingested`, `skipped`,
  `removed`, `failed`), publishing `aviary:rag:media.failed` on the way out. Previously that boundary
  lived inside `AgentMediaIngestionService`'s private `dispatch()`, so anything calling
  `ingestMediaFile` directly — a diagnostics-channel subscriber, a queue consumer, a fire-and-forget
  upload hook — got no failure signal beyond an unhandled rejection. The service now routes through the
  same function, so the inline and direct paths cannot drift.

## 1.1.0

### Minor Changes

- [`a4215cc`](https://github.com/DavideCarvalho/nestjs-agent/commit/a4215ccad313c2eac4a48189a51493fec6f0a8b5) - `MediaIngestionDeps` gains an optional **`metadata`** hook — `(event) => Record<string, unknown>`,
  merged OVER the defaults (`mediaId`, `ownerType`, `ownerId`, `collection`, `size`) so a host can add
  its own keys or override a default one. Whatever it returns is handed to the vector store as-is; this
  package never interprets it.

  This is the seam for host-defined retrieval scoping. Until now the chunk metadata was fixed, so any
  app needing to stamp its own access-control or routing data had to bypass `ingestMediaFile` and
  re-implement the whole read → extract → size-gate → remove → chunk → ingest pipeline. With the hook,
  a capability-token ACL is a one-liner and the pipeline stays in the library:

  ```ts
  ingestMediaFile(event, {
    readFile,
    embedder,
    store,
    metadata: (event) => ({
      collectionId: event.collection,
      audience: tokensFor(event),
    }),
  });
  ```

  Paired with `@dudousxd/nestjs-agent-rag`'s array-valued (match-any) metadata filters, the stamped
  tokens are directly queryable at retrieval time — the store returns only what the caller is entitled
  to, without either package knowing what a token means.

  Also exports **`mimeFromFileName(fileName)`** — extension → mime type for the common document
  formats, the fallback for upload paths that record no content type (S3 objects routinely arrive as
  `application/octet-stream`), so ingestion picks the right extractor instead of skipping the file.
  Unknown extensions yield `application/octet-stream`, which no default extractor handles, preserving
  the skip-don't-index-garbage behaviour.

## 1.0.0

### Patch Changes

- Updated dependencies [[`bd5b15c`](https://github.com/DavideCarvalho/nestjs-agent/commit/bd5b15cc7db3375d54ba41acbf159a28292f0c50)]:
  - @dudousxd/nestjs-agent-rag@0.4.0

## 0.3.10

### Patch Changes

- Updated dependencies [[`70114eb`](https://github.com/DavideCarvalho/nestjs-agent/commit/70114ebb9a7a3702d2efdb11e0dea6956a7ba8db)]:
  - @dudousxd/nestjs-agent-core@0.10.0
  - @dudousxd/nestjs-agent-rag@0.3.10

## 0.3.9

### Patch Changes

- Updated dependencies [[`107fcc2`](https://github.com/DavideCarvalho/nestjs-agent/commit/107fcc2c0079f97c3cc9ff8c83f2dc41070244d5)]:
  - @dudousxd/nestjs-agent-core@0.9.0
  - @dudousxd/nestjs-agent-rag@0.3.9

## 0.3.8

### Patch Changes

- Updated dependencies [[`3d256d4`](https://github.com/DavideCarvalho/nestjs-agent/commit/3d256d4027c7ad819f8ec908425d52887e67da3f)]:
  - @dudousxd/nestjs-agent-core@0.8.0
  - @dudousxd/nestjs-agent-rag@0.3.8

## 0.3.7

### Patch Changes

- Updated dependencies [[`6263338`](https://github.com/DavideCarvalho/nestjs-agent/commit/6263338cf86df7b51cb082d5d2d575987cd13383)]:
  - @dudousxd/nestjs-agent-core@0.7.0
  - @dudousxd/nestjs-agent-rag@0.3.7

## 0.3.6

### Patch Changes

- Updated dependencies [[`eb3aaff`](https://github.com/DavideCarvalho/nestjs-agent/commit/eb3aaff531cc923de1d0bccebb2b0690b4c92263), [`781a30f`](https://github.com/DavideCarvalho/nestjs-agent/commit/781a30f6579d5b9a69f341b8eeac02c273dbb8a1)]:
  - @dudousxd/nestjs-agent-core@0.6.0
  - @dudousxd/nestjs-agent-rag@0.3.6

## 0.3.5

### Patch Changes

- Updated dependencies [[`1c44152`](https://github.com/DavideCarvalho/nestjs-agent/commit/1c4415295a6280527e762f13e6aed48099ae5ca5), [`1c44152`](https://github.com/DavideCarvalho/nestjs-agent/commit/1c4415295a6280527e762f13e6aed48099ae5ca5)]:
  - @dudousxd/nestjs-agent-core@0.5.0
  - @dudousxd/nestjs-agent-rag@0.3.5

## 0.3.4

### Patch Changes

- Updated dependencies [[`abb32bc`](https://github.com/DavideCarvalho/nestjs-agent/commit/abb32bc0396c65a59ee2b92a1a8b07d772215e31)]:
  - @dudousxd/nestjs-agent-core@0.4.0
  - @dudousxd/nestjs-agent-rag@1.0.0

## 0.3.3

### Patch Changes

- Updated dependencies [[`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46), [`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46), [`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46)]:
  - @dudousxd/nestjs-agent-core@0.3.3
  - @dudousxd/nestjs-agent-rag@0.3.3

## 0.3.2

### Patch Changes

- Updated dependencies
- Updated dependencies [ad8e446]
  - @dudousxd/nestjs-agent-core@0.3.2
  - @dudousxd/nestjs-agent-rag@0.3.2

## 0.3.1

### Patch Changes

- Updated dependencies [[`60dcc7d`](https://github.com/DavideCarvalho/nestjs-agent/commit/60dcc7db3764a7d60cb6e4d586f1c0fe7b05ee04)]:
  - @dudousxd/nestjs-agent-core@0.3.1
  - @dudousxd/nestjs-agent-rag@0.3.1
