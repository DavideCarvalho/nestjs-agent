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

/**
 * An **optional** capability a {@link VectorStore} may also implement: *targeted* enumeration and
 * *bulk* deletion, for the collection-maintenance work {@link VectorStore.remove} and
 * {@link VectorStore.listDocuments} can only express one document at a time.
 *
 * The gap it closes is asymptotic, not cosmetic. Dropping a collection through the base interface is
 * `listDocuments()` (which fetches and JSON-parses every chunk's metadata just to collapse it away)
 * followed by one `remove` per document — and on the Redis adapter each of those removes is a `SCAN`
 * that walks the whole keyspace, which in a real deployment also holds queues, workflow state and the
 * app cache. Two thousand documents is two thousand full passes. The methods here do the same work as
 * one filtered query.
 *
 * It is a separate interface, on the {@link LexicalVectorStore} precedent, so that adding it stays
 * additive: a host that wrote its own `VectorStore` keeps compiling, and narrows with
 * {@link isEnumerableVectorStore} when it wants the fast path.
 *
 * Implementations MUST apply filters with exactly the same semantics as {@link VectorStore.search} —
 * including the empty-array deny primitive — because the filter is routinely an access-control
 * boundary. On {@link EnumerableVectorStore.removeWhere} that is not a correctness nicety but the
 * single most destructive thing this interface could get wrong.
 */
export interface EnumerableVectorStore extends VectorStore {
  /**
   * The distinct source document ids currently indexed, optionally narrowed by a metadata `filter` —
   * {@link VectorStore.listDocuments} without the metadata. Use it when you only need the id set (a
   * reconciliation diff against your source of truth, a count, a delete list): implementations are
   * expected to skip fetching and parsing per-chunk metadata entirely, which is most of the cost of
   * `listDocuments` on a large corpus.
   *
   * An empty-array filter value denies, yielding `[]`.
   */
  listDocumentIds(filter?: Record<string, unknown>): Promise<string[]>;

  /**
   * Delete every chunk of every one of `documentIds`, with the same per-document semantics as
   * {@link VectorStore.remove} — but as one bulk operation rather than N independent ones. An empty
   * array is a no-op.
   */
  removeMany(documentIds: string[]): Promise<void>;

  /**
   * Delete every chunk matching a metadata `filter`, and resolve the number of **chunks** removed
   * (not documents). The collection-maintenance primitive: dropping a collection, evicting a tenant,
   * purging a retired audience.
   *
   * Two guard rails, because this is the one method here that destroys data:
   *
   * - **The empty-array deny is honoured, and it means "delete nothing".** `removeWhere({ audience: [] })`
   *   removes zero chunks. Treating a deny as "no filter" would delete the entire corpus, which is
   *   exactly inverted from what the caller asked for.
   * - **The filter must be non-empty.** `removeWhere({})` throws {@link UnsafeRemovalError} rather
   *   than wiping the store, because an empty object is overwhelmingly more likely to be a filter that
   *   got built wrong (a dropped key, an `undefined` scope) than a deliberate request to delete
   *   everything. Deliberate mass deletion stays available and stays explicit:
   *   `removeMany(await store.listDocumentIds())`, or the backend's own drop.
   *
   * What it removes is exactly what a {@link VectorStore.search} carrying the same filter could
   * reach — no more (it cannot escape the filter) and no less.
   */
  removeWhere(filter: Record<string, unknown>): Promise<number>;

  /**
   * How many **chunks** match `filter` (all of them when it is omitted) — a counted query, without
   * transferring the chunks. Sizing a reindex, reporting a collection's footprint, and confirming a
   * {@link EnumerableVectorStore.removeWhere} did what you expected. An empty-array filter value
   * denies, yielding `0`.
   */
  countChunks(filter?: Record<string, unknown>): Promise<number>;
}

/**
 * Does this store carry the optional {@link EnumerableVectorStore} capability? All three adapters this
 * package ships do; a host-written store may not, and should keep working either way.
 */
export function isEnumerableVectorStore(store: VectorStore): store is EnumerableVectorStore {
  const candidate = store as Partial<EnumerableVectorStore>;
  return (
    typeof candidate.listDocumentIds === 'function' &&
    typeof candidate.removeMany === 'function' &&
    typeof candidate.removeWhere === 'function' &&
    typeof candidate.countChunks === 'function'
  );
}

/**
 * A destructive call was refused because its scope could not be trusted. Thrown by
 * {@link EnumerableVectorStore.removeWhere} — never for something that merely matched nothing (that
 * is a legitimate result of `0`), only for a filter that would have deleted *more* than the caller
 * plausibly meant.
 */
export class UnsafeRemovalError extends Error {
  constructor(
    /** Why the removal was refused. */
    readonly reason: 'empty-filter' | 'unindexed-field',
    message: string,
  ) {
    super(message);
    this.name = 'UnsafeRemovalError';
  }
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
