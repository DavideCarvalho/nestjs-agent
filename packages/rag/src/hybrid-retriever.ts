import type { Passage, RetrieveOptions, Retriever } from '@dudousxd/nestjs-agent-core';

export interface HybridRetrieverOptions {
  /** RRF constant — larger flattens the rank weighting. Default 60 (the value from the original paper). */
  k?: number;
  /** Candidates pulled from each retriever before fusion. Default 20. */
  fetchTopK?: number;
  /** Per-retriever multipliers on each RRF contribution (same order as `retrievers`). Default all 1. */
  weights?: number[];
}

/**
 * Fuses several retrievers with Reciprocal Rank Fusion — the robust way to combine, say, dense
 * vector search with lexical BM25. RRF scores each passage by `Σ weight / (k + rank)` across the
 * lists it appears in, so it needs no score normalization between incompatible scales (cosine vs
 * BM25). Deduplicates by passage id, so aligned chunk ids from the two retrievers reinforce.
 */
export class HybridRetriever implements Retriever {
  constructor(
    private readonly retrievers: Retriever[],
    private readonly options: HybridRetrieverOptions = {},
  ) {}

  async retrieve(query: string, options: RetrieveOptions = {}): Promise<Passage[]> {
    const k = this.options.k ?? 60;
    const fetchTopK = this.options.fetchTopK ?? 20;
    const weights = this.options.weights;
    const lists = await Promise.all(
      this.retrievers.map((retriever) =>
        retriever.retrieve(query, {
          topK: fetchTopK,
          ...(options.filter !== undefined ? { filter: options.filter } : {}),
        }),
      ),
    );

    const fused = new Map<string, { passage: Passage; score: number }>();
    lists.forEach((list, listIndex) => {
      const weight = weights?.[listIndex] ?? 1;
      list.forEach((passage, rank) => {
        const contribution = weight / (k + rank + 1);
        const existing = fused.get(passage.id);
        if (existing !== undefined) {
          existing.score += contribution;
        } else {
          fused.set(passage.id, { passage, score: contribution });
        }
      });
    });

    return [...fused.values()]
      .sort((a, b) => b.score - a.score)
      .slice(0, options.topK ?? 5)
      .map((entry) => ({ ...entry.passage, score: entry.score }));
  }
}
