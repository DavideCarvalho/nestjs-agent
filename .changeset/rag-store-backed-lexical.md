---
'@dudousxd/nestjs-agent-rag': minor
---

Store-backed lexical retrieval: hybrid search without an in-process keyword index

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
