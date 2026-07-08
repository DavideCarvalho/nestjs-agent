# nestjs-agent RAG — design spec (2026-07-08)

**Goal:** first-class Retrieval-Augmented Generation for `@dudousxd/nestjs-agent`, as a new
framework-agnostic `-rag` package plus thin `core`/`nestjs` seams. Ships batteries (chunking,
ingestion, in-memory + pgvector stores) while keeping the "SPI + bring-your-own-backend" ethos.

## Decisions (approved by Davi)

- **Full `-rag` package** (not just a docs recipe / thin seam). Repo goes 13 → 14 packages.
- **Vector stores shipped:** `MemoryVectorStore` (JS cosine, zero infra) + `PgVectorStore`
  (drizzle-postgres + pgvector, production reference, testcontainers db-spec).
- **Default retrieval mode = `tool` (agentic):** the model decides when/what to search. `inject`
  (always-on prompt augmentation) is opt-in.
- **Citations reuse the tool-call mechanism — no message-schema change.** Tool mode: sources = the
  retrieval tool's persisted output (already rendered as a tool part + shown in telescope). Inject
  mode: the loop records a synthetic `auto_executed` `retrieve` tool call against the assistant
  message it informed. One `aviary:agent:retrieved` diagnostics event in both modes.

## Architecture — where each piece lives

### `core` (the runtime seams)
- `spi/retriever.ts`: `Passage { id; text; score; source?; metadata? }`, `RetrieveOptions { topK?; filter? }`,
  `Retriever { retrieve(query, opts?): Promise<Passage[]> }`.
- `spi/embedding-provider.ts`: `EmbeddingProvider { embed(texts: string[]): Promise<number[][]> }`.
- `tokens.ts`: `AGENT_RETRIEVER`, `AGENT_EMBEDDING_PROVIDER` (`Symbol.for`).
- `diagnostics.ts`: `AgentRetrieved { runId; query; count }` + `retrieved` channel + `publishAgentRetrieved`.
- `agent-loop.ts`: `AgentLoopDeps.retriever?` + `retrievalTopK?`. When `deps.retriever` is set (inject
  mode): before the turn loop, `hooks.step('retrieve', …)` → augment `system` with a
  `<retrieved_context>` block → `publishAgentRetrieved`. After the first assistant message persists,
  record a synthetic `retrieve` read tool call (output = passages). Presence of `deps.retriever`
  IS inject mode — no separate mode flag in the loop.

### `nestjs` (integration, core-only deps — does NOT import `-rag`)
- `agent.options.ts`: `retrieval?: { mode: 'inject'; retriever: Retriever; topK?: number }`.
- `agent-deps.ts` + factory: thread `retriever`/`retrievalTopK` into `AgentDeps` only when
  `retrieval.mode === 'inject'`.
- Tool mode needs NOTHING here: the host wires `provideAgentTool(createRetrievalTool(retriever))`.

### `@dudousxd/nestjs-agent-rag` (new, framework-agnostic, core-only dep)
- `chunk.ts`: `chunkText(text, { chunkSize=800, overlap=100 }): string[]` (paragraph-greedy w/ overlap).
- `vector-store.ts`: `VectorRecord { id; text; embedding; source?; metadata? }`,
  `VectorStore { upsert(records): Promise<void>; search(embedding, { topK, filter? }): Promise<Passage[]> }`.
- `ingest.ts`: `ingestDocuments(docs, { embedder, store, chunkSize?, overlap? })` — chunk → `embedder.embed`
  (batched) → `store.upsert`. `docs: { id; text; source?; metadata? }[]`.
- `embedding-retriever.ts`: `EmbeddingRetriever implements Retriever` — `retrieve(q)` = embed(q) then
  `store.search`. Bridges `EmbeddingProvider` + `VectorStore` → the core `Retriever` SPI.
- `memory-vector-store.ts`: `MemoryVectorStore implements VectorStore` — in-JS cosine, for tests +
  small scale.
- `pgvector-store.ts`: `PgVectorStore implements VectorStore` — drizzle-postgres + pgvector
  (`<=>` cosine distance). Its own `*.db.spec.ts` via `@testcontainers/postgresql` (`pgvector/pgvector` image).
- `retrieval-tool.ts`: `createRetrievalTool(retriever, opts?): { spec: ToolSpec; handler: ToolHandler }`
  — a `read`-kind tool `search_knowledge(query)` returning `{ passages }`. Structurally a nestjs
  `FunctionalTool`; host passes it to `provideAgentTool`.

### `@dudousxd/nestjs-agent-ai-sdk`
- `aiSdkEmbedding(model): EmbeddingProvider` over the Vercel AI SDK `embedMany`.

### `@dudousxd/nestjs-agent-testing`
- `FakeEmbeddingProvider` — deterministic hash-based vectors, offline (for loop/rag unit tests).

## Wiring (host)

```ts
// Tool mode (default): expose retrieval as a tool the model calls.
providers: [provideAgentTool(createRetrievalTool(retriever))]

// Inject mode: always-on prompt augmentation.
AgentModule.forRoot({ /* … */, retrieval: { mode: 'inject', retriever, topK: 5 } })

// Building a retriever + ingesting:
const retriever = new EmbeddingRetriever(embedder, store)     // embedder: EmbeddingProvider, store: VectorStore
await ingestDocuments(docs, { embedder, store, chunkSize: 800 })
```

## Tests
- core: inject-mode loop test (FakeEmbeddingProvider + MemoryVectorStore) — asserts prompt augmented,
  synthetic tool call recorded, `retrieved` event.
- `-rag` unit: `chunkText` boundaries/overlap, `ingestDocuments` (chunks embedded + upserted),
  `MemoryVectorStore` ranking, `EmbeddingRetriever`, `createRetrievalTool` handler shape.
- `-rag` db: `PgVectorStore` upsert+search against real pgvector (testcontainers).
- nestjs e2e: tool-mode retrieval (model calls the tool, sources in output) + inject-mode (context
  augmented, synthetic tool call persisted).

## Out of scope (follow-ups)
- Reranking seam; hybrid (BM25 + vector) search; async retriever via `forRootAsync`; other vector
  DB adapters (Qdrant/Pinecone/Weaviate) — the `VectorStore` SPI is the extension point.
```
