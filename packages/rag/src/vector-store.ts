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
  /**
   * Delete every chunk belonging to a source document — all records whose id is `${documentId}`
   * or `${documentId}#<n>` (the id scheme {@link import('./ingest.js').chunkDocuments} produces).
   * Use it to drop a document from the index, and before re-ingesting one: `upsert` overwrites
   * matching ids but can't remove chunks a shorter new version no longer produces, so a re-ingest
   * without a preceding `remove` leaves the old tail orphaned.
   */
  remove(documentId: string): Promise<void>;
  /**
   * List the distinct source documents currently indexed (chunk ids collapsed back to their document
   * by stripping the trailing `#<n>`), each with a representative chunk's `metadata`, optionally
   * narrowed by a metadata `filter`. The enumeration seam for reconciliation: diff this against your
   * source of truth to find documents to ingest (missing), re-ingest (a stored fingerprint like
   * `size` changed), or {@link VectorStore.remove remove} (orphaned).
   */
  listDocuments(filter?: Record<string, unknown>): Promise<IndexedDocument[]>;
}

/**
 * An **optional** capability a {@link VectorStore} may also implement: full-text (lexical) search
 * over the chunk text it already stores, using the backing engine's own keyword index — RediSearch's
 * BM25 over the `TEXT` field, say. Its point is the multi-process deployment: when ingestion runs on
 * a worker and search runs on an API pod, the API process never sees the chunks, so the in-process
 * {@link import('./keyword-retriever.js').KeywordRetriever} has nothing to index. A store that
 * implements this needs no second index, no corpus in JS heap, and no refresh window — a chunk is
 * lexically findable the moment it is upserted.
 *
 * Wrap it as a core `Retriever` with {@link import('./lexical-retriever.js').LexicalRetriever}.
 *
 * Implementations MUST apply `options.filter` with exactly the same semantics as
 * {@link VectorStore.search} — including the empty-array deny primitive — because the filter is
 * routinely an access-control boundary, not a hint.
 */
export interface LexicalVectorStore extends VectorStore {
  /**
   * Rank stored chunks against a natural-language `query` by keyword relevance. `options.filter`
   * narrows exactly as in {@link VectorStore.search}. The returned `score` is the engine's own
   * relevance score (BM25), which shares no scale with `search`'s cosine similarity — fuse the two
   * with {@link import('./hybrid-retriever.js').HybridRetriever}, whose RRF is rank-based and so
   * needs no common scale.
   */
  searchText(query: string, options: VectorSearchOptions): Promise<Passage[]>;
}

/**
 * Does this store carry the optional {@link LexicalVectorStore} capability? Lets a consumer pick the
 * store-backed lexical leg when available and fall back to `KeywordRetriever` (or to dense-only)
 * when it is not, without knowing which adapter it was handed.
 */
export function isLexicalVectorStore(store: VectorStore): store is LexicalVectorStore {
  return typeof (store as Partial<LexicalVectorStore>).searchText === 'function';
}

/** A distinct source document as seen by the index — its id plus a representative chunk's metadata. */
export interface IndexedDocument {
  id: string;
  metadata?: Record<string, unknown>;
}

/** Collapse a chunk id (`${documentId}#<n>`) back to its source document id. */
export function documentIdOf(chunkId: string): string {
  return chunkId.replace(/#\d+$/, '');
}
