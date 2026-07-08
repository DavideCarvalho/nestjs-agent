import type { Passage, RerankOptions, Reranker } from '@dudousxd/nestjs-agent-core';

/**
 * A deterministic, offline {@link Reranker} for tests: re-scores each passage by how many distinct
 * query terms it contains (lexical overlap), then sorts descending. No model, no randomness — enough
 * to prove `RerankingRetriever` re-orders and truncates against a known-relevant passage.
 */
export class FakeReranker implements Reranker {
  async rerank(
    query: string,
    passages: Passage[],
    options: RerankOptions = {},
  ): Promise<Passage[]> {
    const terms = new Set(query.toLowerCase().match(/[a-z0-9]+/g) ?? []);
    const scored = passages.map((passage) => {
      const words = new Set(passage.text.toLowerCase().match(/[a-z0-9]+/g) ?? []);
      let overlap = 0;
      for (const term of terms) {
        if (words.has(term)) {
          overlap += 1;
        }
      }
      return { ...passage, score: overlap };
    });
    scored.sort((a, b) => b.score - a.score);
    return options.topK !== undefined ? scored.slice(0, options.topK) : scored;
  }
}
