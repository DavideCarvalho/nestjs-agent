---
'@dudousxd/nestjs-agent-store-mikro-orm': minor
---

Add `rag_ingestion_log` and `MikroOrmRagIngestionLog` — a record of what RAG ingestion *attempted*.

A vector store can only enumerate what it has: a document whose extraction produced no text, whose
mime type had no extractor, or whose embedding call failed has zero chunks, and is therefore
invisible to `VectorStore.listDocuments()`. Without this, a scanned PDF that silently failed to index
is indistinguishable from one that was never uploaded.

The service subscribes to the four `aviary:rag:*` channels `@dudousxd/nestjs-agent-rag-media`
publishes and upserts one row per document id, so the row always reflects the current state — a
successful retry clears the error it replaces. It couples to the channel wire contract rather than
importing `rag-media` (the same convention `rag-media` uses for the media channels it consumes), so
no new dependency. Writes are best-effort and never throw; a lost row costs observability, not data.

Registered by `MikroOrmAgentStoreModule.forFeature()` by default — pass `{ ragIngestionLog: false }`
to opt out. The new table is included in `agentEntities()` and `agentManagedTables()`, so `autoSchema`
creates it and a host's migration differ skips it.
