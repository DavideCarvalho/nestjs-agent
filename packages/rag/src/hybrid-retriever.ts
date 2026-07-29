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
 *
 * ## The score on a fused passage is not a similarity. Do not threshold it.
 *
 * Read this before using `passage.score` for anything other than the order it already produced.
 *
 * Not normalizing between scales is what makes RRF robust, and the price is that the number it
 * emits is a function of **rank alone** — it never sees a similarity at all. Two consequences that
 * bite in practice:
 *
 * - **It is not comparable to the score on a passage from {@link EmbeddingRetriever}**, even though
 *   it arrives in the same field, of the same type, from the same `Retriever` interface. There is no
 *   discriminator; a consumer holding a `Passage[]` cannot tell which kind of number it has. If you
 *   surface scores to a user or a model, know which retriever produced them.
 * - **Its range is narrow, fixed, and says nothing about quality.** Every possible score lies in
 *   `[minWeight / (k + fetchTopK), Σ weights / (k + 1)]` — with the defaults (`k = 60`,
 *   `fetchTopK = 20`, two unweighted legs) that is `[0.0125, 0.0328]`. A perfect match and the
 *   least-bad member of a set of terrible matches both come back around `0.016`.
 *
 * The second point is why a relevance floor cannot live here. What the fused score actually measures
 * is how strongly the legs *agree* — and agreement tracks nothing about correctness. When both legs
 * return the same nearest nothing for an unanswerable query, they reinforce it to the ceiling, the
 * same ceiling a unanimous correct answer gets. Measured on one corpus, the dense leg alone
 * separated cleanly (weakest real answer 0.244, loudest absent-topic answer 0.143) while those same
 * queries after fusion scored 0.032 and 0.033 — inverted. On another corpus the inversion may not
 * appear; what does not change is that both numbers live in a band roughly one part in fifty wide,
 * with no room for a threshold to mean anything.
 *
 * So: put the floor on the legs, with {@link EmbeddingRetrieverOptions.minScore}, and fuse what
 * survives. `HybridRetriever` deliberately has no `minScore` of its own; a threshold option here
 * would be an invitation to apply it to a number that cannot support one.
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
