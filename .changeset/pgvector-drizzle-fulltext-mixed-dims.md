---
'@dudousxd/nestjs-agent-rag': minor
---

`PgVectorStore` takes a `pg` Pool, a Drizzle database or a `postgres.js` `sql` directly (`toPgClient`), upserts in batched multi-row statements, and gains opt-in `nullableEmbeddings`, mixed-dimension tables (`dimensions: [768, 1536]` with one partial HNSW index per width), pgvector ≥ 0.8 `iterativeScan`/`efSearch`, `schemaStatements()` and an overridable `whereConditions`. New `PgLexicalVectorStore` adds Postgres full-text `searchText`, so hybrid search works on Postgres.
