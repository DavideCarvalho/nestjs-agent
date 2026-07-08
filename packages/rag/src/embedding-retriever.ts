import type {
  EmbeddingProvider,
  Passage,
  RetrieveOptions,
  Retriever,
} from '@dudousxd/nestjs-agent-core';
import type { VectorStore } from './vector-store.js';

/**
 * Bridges an {@link EmbeddingProvider} + {@link VectorStore} into the core {@link Retriever} SPI:
 * embed the query, then vector-search. This is what you wire as the agent's retriever (as a tool
 * via `createRetrievalTool`, or into `AgentModule.forRoot({ retrieval })` for inject mode).
 */
export class EmbeddingRetriever implements Retriever {
  constructor(
    private readonly embedder: EmbeddingProvider,
    private readonly store: VectorStore,
  ) {}

  async retrieve(query: string, options: RetrieveOptions = {}): Promise<Passage[]> {
    const [embedding] = await this.embedder.embed([query]);
    if (embedding === undefined) {
      return [];
    }
    return this.store.search(embedding, {
      topK: options.topK ?? 5,
      ...(options.filter !== undefined ? { filter: options.filter } : {}),
    });
  }
}
