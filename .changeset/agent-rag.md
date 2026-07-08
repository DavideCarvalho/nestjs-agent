---
"@dudousxd/nestjs-agent-rag": minor
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-ai-sdk": minor
"@dudousxd/nestjs-agent-testing": minor
---

Add Retrieval-Augmented Generation.

- **New package `@dudousxd/nestjs-agent-rag`** — framework-agnostic (core-only dep): `chunkText`,
  `ingestDocuments` (chunk → embed → upsert), `EmbeddingRetriever` (bridges an embedder + vector
  store to the core `Retriever`), two `VectorStore` adapters — `MemoryVectorStore` (in-JS cosine) and
  `PgVectorStore` (pgvector, via an injected `PgClient` — bring your own `pg`/`postgres.js`) — and
  `createRetrievalTool` for agentic retrieval.
- **Core seams:** `Retriever` and `EmbeddingProvider` SPIs (+ `AGENT_RETRIEVER` /
  `AGENT_EMBEDDING_PROVIDER` tokens), and an `aviary:agent:retrieved` diagnostics event.
- **Two modes.** Agentic (default): `provideAgentTool(createRetrievalTool(retriever))` — the model
  decides when to search. Inject (always-on): `AgentModule.forRoot({ retrieval: { mode: 'inject',
  retriever, topK } })` augments the system prompt with retrieved passages each turn.
- **Citations without a schema change:** passages surface through the tool-call mechanism — the
  retrieval tool's output in agentic mode, and a synthetic `auto_executed` `retrieve` tool call the
  loop records in inject mode — so they render in the chat UI and telescope as-is.
- `@dudousxd/nestjs-agent-ai-sdk` gains `aiSdkEmbedding(model)` (over `embedMany`);
  `@dudousxd/nestjs-agent-testing` gains a deterministic `FakeEmbeddingProvider`.
