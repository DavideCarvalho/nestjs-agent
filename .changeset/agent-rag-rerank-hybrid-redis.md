---
"@dudousxd/nestjs-agent-rag": minor
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent-testing": minor
---

RAG follow-ups: reranking, hybrid search, and a Redis vector store.

- **Reranking.** New `Reranker` core SPI + `RerankingRetriever` — two-stage retrieval that over-fetches
  from a base retriever and reorders with a stronger reranker (bring a Cohere/Voyage/cross-encoder
  model). A deterministic `FakeReranker` ships in `-testing`.
- **Hybrid search.** `HybridRetriever` fuses several retrievers with Reciprocal Rank Fusion (optional
  per-retriever weights) — no score normalization needed between incompatible scales. `KeywordRetriever`
  is a full in-memory BM25 (idf + `k1` saturation + `b` length norm), the lexical half of hybrid.
  New `chunkDocuments` / `ingestChunks` split ingestion so the vector store and the keyword index key
  on identical chunk ids and fuse cleanly.
- **`RedisVectorStore`.** A RediSearch (Redis Stack / Redis 8+) `VectorStore` — HNSW + cosine, FLOAT32
  vectors, declared TAG fields for metadata filtering. Takes an injected `RedisSearchClient`
  (`sendCommand`), so no driver dependency; tolerates both RESP2 and RESP3 `FT.SEARCH` replies.
- Everything is a core `Retriever`, so they compose: `new RerankingRetriever(new HybridRetriever([vector, keyword]), reranker)`.
