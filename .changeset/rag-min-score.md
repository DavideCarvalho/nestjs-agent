---
'@dudousxd/nestjs-agent-rag': minor
---

RAG retrieval: a relevance floor, so a query the corpus cannot answer can return nothing — and a written rule for where a floor may live at all.

A vector search always returns its `topK` nearest neighbours, and "nearest" is not "relevant". Ask a corpus of maintenance policy about the dining hall menu and it hands back the five least unrelated paragraphs it has, each with a score, in confident rank order. Nothing in that result says the answer is absent.

```ts
new EmbeddingRetriever(embedder, store, { minScore: 0.2 })
```

Passages scoring below the floor are dropped. Unset, nothing is dropped — previous behaviour exactly. Applied after the store's search rather than pushed into its query, so the floor is identical across all three adapters instead of subtly engine-specific, and `topK` keeps meaning "ask the store for this many".

**It lives on `EmbeddingRetriever` and deliberately NOT on `HybridRetriever`.** The score on a fused passage is not a similarity and cannot carry a threshold. Not normalizing between incompatible scales is what makes RRF robust, and the price is that its output is a function of rank alone — it never sees a similarity at all. Two consequences that bite:

- It is **not comparable** to the score from `EmbeddingRetriever`, despite arriving in the same field, of the same type, through the same `Retriever` interface. There is no discriminator: a consumer holding a `Passage[]` cannot tell which kind of number it has.
- Its range is **narrow, fixed, and quality-blind**: every possible score lies in `[minWeight / (k + fetchTopK), Σ weights / (k + 1)]` — with the defaults, `[0.0125, 0.0328]`. A perfect match and the least-bad member of a set of terrible matches both land around `0.016`.

What a fused score actually measures is how strongly the legs *agree*, and agreement tracks nothing about correctness: two legs returning the same nearest nothing reinforce it to the same ceiling a unanimous correct answer gets. Measured on one corpus, the dense leg alone separated cleanly (weakest real answer `0.244`, loudest absent-topic answer `0.143`) while those same queries after fusion scored `0.032` and `0.033` — inverted.

So: threshold the legs, then fuse. A `minScore` on `HybridRetriever` would have been an invitation to apply one to a number that cannot support it, which is why the option is absent rather than merely discouraged. The band is pinned by a test, so the documented range cannot rot into a lie.
