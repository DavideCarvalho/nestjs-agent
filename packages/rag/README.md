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

## Hybrid search — and deleting from it

Hybrid search means chunking once and feeding the SAME chunks to both halves, so their ids line up
and `HybridRetriever` can fuse the rankings:

```ts
const chunks = chunkDocuments(docs);
await ingestChunks(chunks, { embedder, store });
keyword.add(chunks);

const retriever = new HybridRetriever([new EmbeddingRetriever(embedder, store), keyword]);
```

Because there are two indexes, **deletes have to hit both**. `KeywordRetriever` keeps its own copy of
each chunk's text, so a document dropped from the vector store alone stays fully retrievable —
`retrieve` will keep returning the removed passage:

```ts
await store.remove(documentId);
keyword.remove(documentId); // ← the other half. Same document id; chunk ids collapse for you.
```

`KeywordRetriever` also exposes `clear()` and `size` for rebuilding the index wholesale.

## RediSearch store

`RedisVectorStore` needs `ensureSchema()` at boot. It creates the index if missing — and if the index
already exists, it compares it against your configuration rather than assuming they agree. A
`filterableFields` entry added after the index was created is repaired in place with
`FT.ALTER … SCHEMA ADD` (chunks written before the repair only become filterable on that key once
re-ingested). A changed `dimensions` — a model swap — can't be repaired without a full reindex, so it
throws `RedisVectorSchemaMismatchError` instead of silently leaving the index on the old width.

## API

- `chunkText(text, { chunkSize?, overlap? })` — overlapping, boundary-aware chunks.
- `ingestDocuments(docs, { embedder, store, chunkSize?, overlap? })` — chunk → embed → upsert.
- `EmbeddingRetriever(embedder, store)` — the core `Retriever` from an embedder + vector store.
- `KeywordRetriever` — BM25 lexical half of hybrid search: `add(chunks)`, `remove(documentId)`,
  `clear()`, `size`.
- `MemoryVectorStore` / `PgVectorStore` / `RedisVectorStore` — `VectorStore` adapters.
- `createRetrievalTool(retriever, { name?, description?, topK? })` — the agentic-retrieval tool.
