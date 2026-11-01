---
'@dudousxd/nestjs-agent-rag': minor
'@dudousxd/nestjs-agent-store-mikro-orm': minor
---

RAG declared per model. `RagRepository` and `RagModule` (`@dudousxd/nestjs-agent-rag/nestjs`, with `@nestjs/common` as an optional peer) and the framework-free `RagIndex`: a scope a search can't omit or override, no indexing on save, embeddings before replacing chunks, `reconcile` for what no hook sees, and `onUsage`. `provideRagDeleteSync` in the MikroORM store removes chunks after the commit. Also new: `vectorType: 'halfvec'` on `PgVectorStore`, `filter: (ctx) => ...` on `createRetrievalTool`, and `embedWithUsage` on `openAiEmbeddings`.
