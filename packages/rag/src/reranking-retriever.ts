import type { Passage, Reranker, RetrieveOptions, Retriever } from '@dudousxd/nestjs-agent-core';
import { type RetrievalDescriptor, describeSource } from './retrieval-descriptor.js';

export interface RerankingRetrieverOptions {
  /** How many candidates to pull from the base retriever before reranking. Default 20. */
  fetchTopK?: number;
}

/**
 * Two-stage retrieval: over-fetch cheap candidates from a base `Retriever`, then reorder them with a
 * stronger {@link Reranker} and keep the top few. The standard precision boost — a fast first stage
 * casts a wide net, a slow accurate second stage sharpens it. Composes over ANY retriever (vector,
 * hybrid, keyword), and is itself a `Retriever`.
 */
export class RerankingRetriever implements Retriever {
  constructor(
    private readonly base: Retriever,
    private readonly reranker: Reranker,
    private readonly options: RerankingRetrieverOptions = {},
  ) {}

  /** Telemetry self-description — the two-stage strategy, over the base's store. */
  describeRetrieval(): RetrievalDescriptor {
    return { retriever: 'reranking', ...describeSource(this.base) };
  }

  async retrieve(query: string, options: RetrieveOptions = {}): Promise<Passage[]> {
    const candidates = await this.base.retrieve(query, {
      topK: this.options.fetchTopK ?? 20,
      ...(options.filter !== undefined ? { filter: options.filter } : {}),
    });
    return this.reranker.rerank(query, candidates, { topK: options.topK ?? 5 });
  }
}
