# @dudousxd/nestjs-agent-rag

Retrieval-Augmented Generation for [`@dudousxd/nestjs-agent`](../nestjs). Chunking, ingestion, an
embedding-backed `Retriever`, and three vector stores — in-memory, pgvector and RediSearch.
Framework-agnostic: it depends only on `-core`, and you bring your own embedding model and (for the
pgvector / RediSearch stores) database driver.

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

## RediSearch store

`RedisVectorStore` takes anything that can send a raw command — `node-redis`, or `ioredis` wrapped —
so this package pulls in no Redis driver either. Needs the RediSearch module (Redis Stack / Redis 8+):

```ts
import { createClient } from 'redis';
import { RedisVectorStore } from '@dudousxd/nestjs-agent-rag';

const client = createClient({ url: process.env.REDIS_URL });
await client.connect();

const store = new RedisVectorStore(
  { sendCommand: (args) => client.sendCommand(args) },
  { dimensions: 1536, filterableFields: ['audience'] },
);
await store.ensureSchema(); // FT.CREATE: TEXT + TAG + HNSW cosine vector field
```

`filterableFields` declares which metadata keys become filterable `TAG` fields — RediSearch needs them
up front, so only those keys can be used in a `filter`. This store also does lexical search; see below.

`ensureSchema()` belongs at boot. It creates the index if missing — and if the index already exists,
it compares it against your configuration rather than assuming they agree. A `filterableFields` entry
added after the index was created is repaired in place with `FT.ALTER … SCHEMA ADD` (chunks written
before the repair only become filterable on that key once re-ingested). A changed `dimensions` — a
model swap — can't be repaired without a full reindex, so it throws `RedisVectorSchemaMismatchError`
instead of silently leaving the index on the old width.

## Hybrid search (dense + lexical)

`HybridRetriever` fuses several retrievers with Reciprocal Rank Fusion. RRF is **rank**-based, so the
two halves need no common score scale — cosine similarity and BM25 fuse as they are.

There are two ways to get the lexical half, and which one you want is decided by your deployment, not
your taste.

**Store-backed (the default for anything multi-process).** `RedisVectorStore` already declares the
chunk text as a RediSearch `TEXT` field, so the lexical index is *already there* — `LexicalRetriever`
just queries it with BM25:

```ts
import { EmbeddingRetriever, HybridRetriever, LexicalRetriever } from '@dudousxd/nestjs-agent-rag';

const retriever = new HybridRetriever([
  new EmbeddingRetriever(embedder, store),
  new LexicalRetriever(store), // ← same store, no second index
]);
```

Nothing else changes: no chunks to hand the retriever, no state in the process, no deletes to mirror.
This is the only option that works when **ingestion and search run in different processes** — a
worker that ingests and an API pod that searches. The API pod never sees the chunks, so an in-process
index there would be permanently empty (or kept warm by scanning the corpus into JS heap on every
pod, which is the workaround this exists to delete). It also means a document is lexically findable
the moment it is upserted, with no refresh window.

`searchText` applies `filter` with exactly the same semantics as `search` — array = OR, **empty array
= deny** — so a lexical hit can never escape a filter a vector hit would have respected. That matters
when the filter is carrying capability tokens rather than a hint.

A query is reduced to letter/digit/`_` terms before it is sent, so RediSearch query syntax in user
input (`*`, `@field:{…}`, `|`, `-`, `=>[KNN …]`) is inert rather than escaped-but-live. A query with
no searchable terms left — empty, whitespace, or pure punctuation — returns `[]` rather than matching
the corpus.

**In-process (`KeywordRetriever`).** Still the right answer for `MemoryVectorStore`, for a store with
no lexical capability, and for single-process deployments where you control both halves. It is a full
BM25 implementation over chunks you feed it, so chunk once and give the SAME chunks to both halves —
their ids line up and `HybridRetriever` can fuse the rankings:

```ts
const chunks = chunkDocuments(docs);
await ingestChunks(chunks, { embedder, store });
keyword.add(chunks); // its own copy of the corpus, in this process only

const retriever = new HybridRetriever([new EmbeddingRetriever(embedder, store), keyword]);
```

Because that is a second index, **deletes have to hit both**, and only this process can see it.
`KeywordRetriever` keeps its own copy of each chunk's text, so a document dropped from the vector
store alone stays fully retrievable — `retrieve` will keep returning the removed passage:

```ts
await store.remove(documentId);
keyword.remove(documentId); // ← the other half. Same document id; chunk ids collapse for you.
```

`KeywordRetriever` also exposes `clear()` and `size` for rebuilding the index wholesale. None of this
bookkeeping exists on the store-backed path above, which is the point of it.

Ask the store which it supports rather than hard-coding:

```ts
import { isLexicalVectorStore } from '@dudousxd/nestjs-agent-rag';

const lexical = isLexicalVectorStore(store) ? new LexicalRetriever(store) : keywordRetriever;
```

### Which stores implement `LexicalVectorStore`

| Store | Lexical | Why |
| --- | --- | --- |
| `RedisVectorStore` | ✅ | RediSearch indexes the chunk text as `TEXT`; BM25 is already there |
| `PgVectorStore` | ❌ | the chunks table has no `tsvector`/GIN index, and adding one is a migration |
| `MemoryVectorStore` | ❌ | single-process by definition — use `KeywordRetriever` |

Postgres is a deliberate omission. Lexical search there needs new DDL (a GIN index), and `CREATE
INDEX` in `ensureSchema` would take a write lock on an already-populated chunks table at boot; it also
forces a text-search-configuration choice that must match between index and query or Postgres silently
falls back to a sequential scan. That wants a migration you run and watch, not a side effect of a
library upgrade. The interface is open, so it can be added later without changing anything else.

## API

- `chunkText(text, { chunkSize?, overlap? })` — overlapping, boundary-aware chunks.
- `ingestDocuments(docs, { embedder, store, chunkSize?, overlap? })` — chunk → embed → upsert.
- `EmbeddingRetriever(embedder, store)` — the core `Retriever` from an embedder + vector store.
- `LexicalRetriever(store)` — the core `Retriever` from a store's own full-text index (BM25).
- `KeywordRetriever` — in-process BM25 over chunks you feed it; the single-process lexical half:
  `add(chunks)`, `remove(documentId)`, `clear()`, `size`.
- `HybridRetriever(retrievers, { k?, fetchTopK?, weights? })` — RRF fusion of the two.
- `MemoryVectorStore` / `PgVectorStore` / `RedisVectorStore` — `VectorStore` adapters.
- `isLexicalVectorStore(store)` — type guard for the optional `LexicalVectorStore` capability.
- `createRetrievalTool(retriever, { name?, description?, topK? })` — the agentic-retrieval tool.
