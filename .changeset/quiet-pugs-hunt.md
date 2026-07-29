---
'@dudousxd/nestjs-agent-rag': minor
---

RAG stores: targeted enumeration and bulk deletion, so collection maintenance stops costing a full keyspace pass per document.

New optional `EnumerableVectorStore` capability (same shape as `LexicalVectorStore` — additive, narrow with `isEnumerableVectorStore(store)`), implemented by all three shipped adapters:

- `listDocumentIds(filter?)` — the distinct document ids, without fetching or JSON-parsing a metadata blob per chunk (`FT.SEARCH … NOCONTENT` / `SELECT DISTINCT`).
- `removeMany(documentIds)` — N documents in one pass instead of N independent ones.
- `removeWhere(filter)` — delete a whole scope with one filtered query, resolving the number of chunks removed. No keyspace scan on Redis.
- `countChunks(filter?)` — a counted query (`FT.SEARCH … LIMIT 0 0` / `count(*)`), no chunks transferred.

`removeWhere` honours the package's empty-array **deny** primitive: `removeWhere({ audience: [] })` deletes nothing and returns `0`, and a deny ANDed with a matching scope still denies. An empty filter object (`removeWhere({})`) throws the new `UnsafeRemovalError` instead of wiping the store — deliberate mass deletion stays available as `removeMany(await store.listDocumentIds())`. On Redis, a filter key with no declared `meta_*` TAG throws rather than being handed to the engine.

`VectorStore.remove` is unchanged. Making it index-backed would require stamping the document id at write time, and chunks written before that change would become undeletable without any error — the new methods deliver the asymptotic win with no migration.
