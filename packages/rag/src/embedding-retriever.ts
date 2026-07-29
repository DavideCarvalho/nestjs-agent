import type {
  EmbeddingProvider,
  Passage,
  RetrieveOptions,
  Retriever,
} from '@dudousxd/nestjs-agent-core';
import type { VectorStore } from './vector-store.js';

export interface EmbeddingRetrieverOptions {
  /**
   * Drop passages scoring below this, so a query the corpus cannot answer returns nothing.
   *
   * A vector search always returns its `topK` nearest neighbours, and "nearest" is not "relevant".
   * Ask a corpus of maintenance policy about the dining hall menu and it hands back the five least
   * unrelated paragraphs it has, each with a score, in confident rank order. Nothing in that result
   * says the answer is absent, so without a floor the consumer either feeds a model five irrelevant
   * passages or invents a threshold of its own.
   *
   * **This is the only place in the package where a threshold is meaningful, which is why it lives
   * here and not on `HybridRetriever`.** The score here comes straight from the store's vector
   * search: a calibrated similarity, comparable across queries and monotonic in how well the passage
   * matches. A fused score is neither — see the score section on `HybridRetriever`. Threshold each
   * leg, then fuse; never the other way round.
   *
   * Pick the number by measuring, not by taste: score questions you know the corpus answers against
   * questions you know it does not, and put the floor in the gap between the two populations. It is
   * specific to the embedding model and the distance metric, so it does not survive changing either.
   * Left unset nothing is dropped, which is the previous behaviour exactly.
   */
  minScore?: number;
}

/**
 * Bridges an {@link EmbeddingProvider} + {@link VectorStore} into the core {@link Retriever} SPI:
 * embed the query, then vector-search. This is what you wire as the agent's retriever (as a tool
 * via `createRetrievalTool`, or into `AgentModule.forRoot({ retrieval })` for inject mode).
 */
export class EmbeddingRetriever implements Retriever {
  constructor(
    private readonly embedder: EmbeddingProvider,
    private readonly store: VectorStore,
    private readonly options: EmbeddingRetrieverOptions = {},
  ) {}

  async retrieve(query: string, options: RetrieveOptions = {}): Promise<Passage[]> {
    const [embedding] = await this.embedder.embed([query]);
    if (embedding === undefined) {
      return [];
    }
    const passages = await this.store.search(embedding, {
      topK: options.topK ?? 5,
      ...(options.filter !== undefined ? { filter: options.filter } : {}),
    });
    const { minScore } = this.options;
    // Applied here rather than pushed into the store's query: not every backend can express "score
    // above X" in the same call as its KNN search, and filtering after keeps the floor byte-identical
    // across all three adapters instead of subtly engine-specific. It also keeps `topK` meaning "ask
    // the store for this many", so a floor never silently turns into a smaller search.
    return minScore === undefined
      ? passages
      : passages.filter((passage) => passage.score >= minScore);
  }
}
