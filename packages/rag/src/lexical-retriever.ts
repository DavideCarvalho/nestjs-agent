import type { Passage, RetrieveOptions, Retriever } from '@dudousxd/nestjs-agent-core';
import { type RetrievalDescriptor, describeSource } from './retrieval-descriptor.js';
import type { LexicalVectorStore } from './vector-store.js';

/**
 * The keyword half of hybrid search, served by the store's own full-text index — the mirror of
 * {@link import('./embedding-retriever.js').EmbeddingRetriever}, which serves the dense half. It
 * holds no state: every query goes to the store, so any process that can reach the store can run
 * lexical search, whether or not it did the ingestion.
 *
 * Compose it exactly like the dense leg:
 *
 * ```ts
 * const retriever = new HybridRetriever([
 *   new EmbeddingRetriever(embedder, store),
 *   new LexicalRetriever(store),
 * ]);
 * ```
 *
 * Both legs read the same chunks from the same index, so their ids line up by construction and
 * `HybridRetriever`'s RRF fuses them without either side needing a score on a common scale.
 *
 * Prefer this over {@link import('./keyword-retriever.js').KeywordRetriever} whenever the store
 * supports it (see {@link import('./vector-store.js').isLexicalVectorStore}) and ingestion and
 * search can run in different processes; `KeywordRetriever` remains the answer for `MemoryVectorStore`
 * and single-process deployments.
 */
export class LexicalRetriever implements Retriever {
  constructor(private readonly store: LexicalVectorStore) {}

  /** Telemetry self-description — the store's own lexical index, so the store is the same one. */
  describeRetrieval(): RetrievalDescriptor {
    return { retriever: 'lexical', ...describeSource(this.store) };
  }

  async retrieve(query: string, options: RetrieveOptions = {}): Promise<Passage[]> {
    return this.store.searchText(query, {
      topK: options.topK ?? 5,
      ...(options.filter !== undefined ? { filter: options.filter } : {}),
    });
  }
}
