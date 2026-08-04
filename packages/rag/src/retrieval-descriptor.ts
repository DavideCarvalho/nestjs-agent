/**
 * What a retrieval was served BY — the static half of retrieval telemetry, separated from the
 * emitting half (`retrieval-telemetry.ts`) so a store or a retriever can describe itself without
 * importing anything that emits. That separation is not tidiness: `retrieval-telemetry.ts` imports
 * the retrievers' shapes to detect them, and the retrievers import their descriptor kind, so putting
 * both halves in one module would make every retriever ↔ telemetry edge a cycle.
 */

/** Which retrieval strategy answered. `unknown` is a retriever this package did not ship. */
export type RetrieverKind =
  | 'embedding'
  | 'keyword'
  | 'lexical'
  | 'hybrid'
  | 'filtered'
  | 'reranking'
  | 'unknown';

/** Which backend held the chunks. Omitted entirely for a retriever that holds its own (keyword). */
export type VectorStoreKind = 'memory' | 'pg' | 'redis';

/**
 * A retriever's (or a store's) self-description, as it appears on a retrieval event. Every field is
 * optional because the describer is answering only for the layer it *is*: a store knows its backend
 * and namespace but not which strategy queried it; `KeywordRetriever` knows its strategy but has no
 * store at all.
 */
export interface RetrievalDescriptor {
  retriever?: RetrieverKind;
  store?: VectorStoreKind;
  /**
   * The namespace the chunks live in — `PgVectorStore`'s table, `RedisVectorStore`'s RediSearch
   * index. This is the STORE-level namespace, not a per-query metadata scope: a host that partitions
   * one index into logical collections with a metadata filter (the usual multi-tenant shape) reports
   * that through `InstrumentRetrieverOptions.collection`, which overrides this.
   */
  collection?: string;
}

/**
 * The optional capability a store or retriever implements to appear on a retrieval event as
 * something other than `unknown`. Deliberately NOT a member of `VectorStore` or of core's
 * `Retriever`: both are implemented outside this package, and adding a required member to either
 * would break every existing implementation on upgrade — for a field that only observability reads.
 */
export interface DescribesRetrieval {
  describeRetrieval(): RetrievalDescriptor;
}

/** Structural guard, so a `VectorStore`/`Retriever` is narrowed to the capability without a cast. */
export function describesRetrieval(value: unknown): value is DescribesRetrieval {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'describeRetrieval') === 'function'
  );
}

/** A candidate's descriptor, or an empty one when it does not carry the capability. */
export function describeRetrieval(candidate: unknown): RetrievalDescriptor {
  return describesRetrieval(candidate) ? candidate.describeRetrieval() : {};
}

/**
 * The store half of a wrapped retriever's descriptor: the base's `store`/`collection` with its
 * `retriever` dropped, so the wrapper can stamp its own strategy on top.
 *
 * `new FilteredRetriever(new EmbeddingRetriever(embedder, pg), scope)` therefore reports
 * `{ retriever: 'filtered', store: 'pg', collection: 'agent_rag_chunks' }` rather than losing the
 * store: which backend answered is the thing a "retrievals by store" panel exists to show, and a
 * production wiring is almost always two or three wrappers deep.
 */
export function describeSource(base: unknown): Omit<RetrievalDescriptor, 'retriever'> {
  const { retriever: _ignored, ...source } = describeRetrieval(base);
  return source;
}

/**
 * The store half shared by EVERY leg of a composed retriever, or nothing when they disagree.
 *
 * A hybrid whose legs are the dense and lexical halves of the same RediSearch index (the shape
 * `LexicalRetriever` exists for) genuinely was served by that one store, and reporting it is what
 * makes the store breakdown add up. A hybrid fusing pgvector with an in-process BM25 index was not
 * served by either alone, and picking the first leg would silently attribute every such retrieval to
 * a store that answered half of it.
 */
export function describeSharedSource(
  legs: readonly unknown[],
): Omit<RetrievalDescriptor, 'retriever'> {
  const sources = legs.map(describeSource);
  const [first] = sources;
  if (first === undefined) {
    return {};
  }
  const agrees = sources.every(
    (source) => source.store === first.store && source.collection === first.collection,
  );
  return agrees ? first : {};
}
