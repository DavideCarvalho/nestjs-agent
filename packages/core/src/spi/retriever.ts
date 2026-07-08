/**
 * Retrieval seam for RAG. A `Retriever` is a black box — the agent runtime asks it for the passages
 * most relevant to a query and never sees how (vector search, keyword, hybrid, a remote service).
 * The `@dudousxd/nestjs-agent-rag` package ships an `EmbeddingRetriever` (embed + vector store) and
 * store adapters, but any impl satisfying this SPI works. Wire it as a tool for agentic retrieval
 * (`createRetrievalTool`), or for always-on injection via `AgentModule.forRoot({ retrieval })`.
 */

/** One retrieved passage. `source` is a human/citation-facing origin; `score` is impl-defined relevance. */
export interface Passage {
  id: string;
  text: string;
  score: number;
  /** Where the passage came from (document title, URL, row id) — surfaced as a citation. */
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface RetrieveOptions {
  /** Max passages to return. The impl may cap it; the loop defaults to 5 when unset. */
  topK?: number;
  /** Impl-specific metadata filter (e.g. `{ tenantRef }`). Opaque to the runtime. */
  filter?: Record<string, unknown>;
}

export interface Retriever {
  retrieve(query: string, options?: RetrieveOptions): Promise<Passage[]>;
}
