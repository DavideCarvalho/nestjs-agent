# @dudousxd/nestjs-agent-rag

Retrieval-Augmented Generation for [`@dudousxd/nestjs-agent`](../nestjs). Chunking, ingestion, an
embedding-backed `Retriever`, and two vector stores — in-memory and pgvector. Framework-agnostic:
it depends only on `-core`, and you bring your own embedding model and (for pgvector) Postgres driver.

## Install

```bash
pnpm add @dudousxd/nestjs-agent-rag @dudousxd/nestjs-agent-core
```

## Build a retriever + ingest

```ts
import { EmbeddingRetriever, MemoryVectorStore, ingestDocuments } from '@dudousxd/nestjs-agent-rag';
import { aiSdkEmbedding } from '@dudousxd/nestjs-agent-ai-sdk';
import { openai } from '@ai-sdk/openai';

const embedder = aiSdkEmbedding(openai.embedding('text-embedding-3-small'));
const store = new MemoryVectorStore(); // or PgVectorStore for production

await ingestDocuments(
  [{ id: 'refund-policy', text: '…', source: 'docs/refunds' }],
  { embedder, store, chunkSize: 800 },
);

const retriever = new EmbeddingRetriever(embedder, store);
```

## Two ways to use it with the agent

**Agentic (default) — the model decides when to search:**

```ts
import { createRetrievalTool } from '@dudousxd/nestjs-agent-rag';
import { provideAgentTool } from '@dudousxd/nestjs-agent';

@Module({ providers: [provideAgentTool(createRetrievalTool(retriever))] })
export class AppModule {}
```

**Inject (always-on) — augment every turn's prompt with retrieved context:**

```ts
AgentModule.forRoot({
  // …model, store, actorResolver…
  retrieval: { mode: 'inject', retriever, topK: 5 },
});
```

Either way, retrieved passages carry a `source` and surface as citations through the normal
tool-call machinery (rendered in the chat UI, shown in the `-telescope` Agent tab). Each retrieval
also emits an `aviary:agent:retrieved` diagnostics event.

## pgvector store

`PgVectorStore` takes an injected `PgClient` — adapt your own `pg` / `postgres.js`:

```ts
import { Pool } from 'pg';
import { PgVectorStore } from '@dudousxd/nestjs-agent-rag';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = new PgVectorStore(
  { query: (sql, params) => pool.query(sql, params).then((r) => r.rows) },
  { dimensions: 1536 },
);
await store.ensureSchema(); // CREATE EXTENSION vector + table + HNSW cosine index
```

## API

- `chunkText(text, { chunkSize?, overlap? })` — overlapping, boundary-aware chunks.
- `ingestDocuments(docs, { embedder, store, chunkSize?, overlap? })` — chunk → embed → upsert.
- `EmbeddingRetriever(embedder, store)` — the core `Retriever` from an embedder + vector store.
- `MemoryVectorStore` / `PgVectorStore` — `VectorStore` adapters.
- `createRetrievalTool(retriever, { name?, description?, topK? })` — the agentic-retrieval tool.
