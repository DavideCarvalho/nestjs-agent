---
'@dudousxd/nestjs-agent-rag': minor
---

RAG stores: targeted enumeration and bulk deletion, so collection maintenance stops costing a full keyspace pass per document.

Four new **required** members of `VectorStore`, implemented by all three shipped adapters:

- `listDocumentIds(filter?)` — the distinct document ids, without fetching or JSON-parsing a metadata blob per chunk (`FT.SEARCH … NOCONTENT` / `SELECT DISTINCT`).
- `removeMany(documentIds)` — N documents in one pass instead of N independent ones.
- `removeWhere(filter)` — delete a whole scope with one filtered query, resolving the number of chunks removed. No keyspace scan on Redis.
- `countChunks(filter?)` — a counted query (`FT.SEARCH … LIMIT 0 0` / `count(*)`), no chunks transferred.

**Breaking for anyone who wrote their own `VectorStore`:** a store implementing only the previous five members no longer satisfies the interface and will not compile until the four methods are added. That is deliberate, and it is why this did not ship as an optional capability interface. These are CRUD over records the store already holds — the same footing as `remove` and `listDocuments` — so making them optional would have bought every *consumer* a permanent `if (isEnumerableVectorStore(store))` plus an unreachable "and if it isn't?" branch, forever, to protect a case that does not exist: this package is 0.x, all three adapters are in-tree, and there are no known external implementations. It stays a **minor** accordingly.

`LexicalVectorStore.searchText` stays optional, and the `VectorStore` doc comment now records the rule that separates the two: required when every backend *can* do it from what it already stores; optional only when some backend genuinely cannot without infrastructure the consumer has to adopt (Postgres would need a `tsvector` column, a GIN index and a migration; `MemoryVectorStore` would have to implement BM25 itself).

`removeWhere` honours the package's empty-array **deny** primitive: `removeWhere({ audience: [] })` deletes nothing and returns `0`, and a deny ANDed with a matching scope still denies. An empty filter object (`removeWhere({})`) throws the new `UnsafeRemovalError` instead of wiping the store — deliberate mass deletion stays available as `removeMany(await store.listDocumentIds())`. On Redis, a filter key with no declared `meta_*` TAG throws rather than being handed to the engine.

`VectorStore.remove` is unchanged. Making it index-backed would require stamping the document id at write time, and chunks written before that change would become undeletable without any error — the new methods deliver the asymptotic win with no migration.
