import type { Passage } from '@dudousxd/nestjs-agent-core';

/** A stored, embedded chunk. `embedding` length must match the store's configured dimensions. */
export interface VectorRecord {
  id: string;
  text: string;
  embedding: number[];
  /** Citation-facing origin (document title, URL, row id). */
  source?: string;
  metadata?: Record<string, unknown>;
}

export interface VectorSearchOptions {
  topK: number;
  /** Exact-match metadata filter (all keys must equal). Passed through from `RetrieveOptions.filter`. */
  filter?: Record<string, unknown>;
}

/**
 * The write + search side of RAG storage. `@dudousxd/nestjs-agent-rag` ships `MemoryVectorStore`
 * (in-JS cosine, tests + small scale) and `PgVectorStore` (pgvector); any impl works. Pair one with
 * an `EmbeddingProvider` via {@link import('./embedding-retriever.js').EmbeddingRetriever} to get a
 * core `Retriever`.
 */
export interface VectorStore {
  upsert(records: VectorRecord[]): Promise<void>;
  search(embedding: number[], options: VectorSearchOptions): Promise<Passage[]>;
}
