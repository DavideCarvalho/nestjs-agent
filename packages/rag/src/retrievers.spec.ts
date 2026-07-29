import { FakeEmbeddingProvider, FakeReranker } from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import { EmbeddingRetriever } from './embedding-retriever.js';
import { HybridRetriever } from './hybrid-retriever.js';
import { chunkDocuments, ingestChunks } from './ingest.js';
import { KeywordRetriever } from './keyword-retriever.js';
import { MemoryVectorStore } from './memory-vector-store.js';
import { RerankingRetriever } from './reranking-retriever.js';

const DOCS = [
  { id: 'cats', text: 'Cats are domestic felines that purr and chase mice.', source: 'animals' },
  { id: 'rockets', text: 'Rockets burn propellant to reach orbit.', source: 'space' },
  {
    id: 'dogs',
    text: 'Dogs are loyal domestic canines that bark at strangers.',
    source: 'animals',
  },
];

describe('KeywordRetriever (BM25)', () => {
  it('ranks the term-matching doc first', async () => {
    const keyword = new KeywordRetriever();
    keyword.add(chunkDocuments(DOCS));
    const passages = await keyword.retrieve('domestic felines chase mice', { topK: 3 });
    expect(passages[0]?.id).toBe('cats#0');
  });

  it('filters by metadata', async () => {
    const keyword = new KeywordRetriever();
    keyword.add(chunkDocuments(DOCS.map((doc) => ({ ...doc, metadata: { kind: doc.source } }))));
    const passages = await keyword.retrieve('domestic', { topK: 5, filter: { kind: 'animals' } });
    expect(passages.length).toBeGreaterThan(0);
    expect(passages.every((passage) => passage.metadata?.kind === 'animals')).toBe(true);
  });

  it('re-adding an id replaces its posting', async () => {
    const keyword = new KeywordRetriever();
    keyword.add([{ id: 'd', text: 'alpha alpha alpha' }]);
    keyword.add([{ id: 'd', text: 'beta gamma' }]);
    expect(await keyword.retrieve('alpha', { topK: 5 })).toHaveLength(0);
    expect(await keyword.retrieve('beta', { topK: 5 })).toHaveLength(1);
  });
});

describe('KeywordRetriever.remove (delete-sync with the vector store)', () => {
  it('a removed document is gone from retrieve — every chunk of it, text and all', async () => {
    const keyword = new KeywordRetriever();
    // multi-chunk, so the `${documentId}#<n>` collapse is what has to do the work
    keyword.add(
      chunkDocuments([{ id: 'cats', text: DOCS[0]?.text ?? '' }], { chunkSize: 20, overlap: 0 }),
    );
    expect(keyword.size).toBeGreaterThan(1);

    keyword.remove('cats');

    expect(keyword.size).toBe(0);
    expect(await keyword.retrieve('domestic felines chase mice', { topK: 10 })).toEqual([]);
  });

  it('removing one document leaves the others intact', async () => {
    const keyword = new KeywordRetriever();
    keyword.add(chunkDocuments(DOCS));

    keyword.remove('cats');

    const passages = await keyword.retrieve('domestic', { topK: 10 });
    const ids = passages.map((passage) => passage.id);
    expect(ids).not.toContain('cats#0');
    expect(ids).toContain('dogs#0');
    expect(keyword.size).toBe(2);
  });

  it('spares a different document that merely shares the id prefix', async () => {
    const keyword = new KeywordRetriever();
    keyword.add([
      { id: 'gone#0', text: 'alpha' },
      { id: 'gone', text: 'alpha' },
      { id: 'goner#0', text: 'alpha' },
    ]);

    keyword.remove('gone');

    expect((await keyword.retrieve('alpha', { topK: 10 })).map((passage) => passage.id)).toEqual([
      'goner#0',
    ]);
  });

  it('removing an unknown id is a no-op', async () => {
    const keyword = new KeywordRetriever();
    keyword.add(chunkDocuments(DOCS));

    keyword.remove('never-indexed');

    expect(keyword.size).toBe(3);
    expect(await keyword.retrieve('domestic felines chase mice', { topK: 3 })).not.toHaveLength(0);
  });

  it('keeps BM25 statistics consistent: scores match a corpus built without the removed doc', async () => {
    const removed = new KeywordRetriever();
    removed.add(chunkDocuments(DOCS));
    removed.remove('cats');

    const fresh = new KeywordRetriever();
    fresh.add(chunkDocuments(DOCS.filter((doc) => doc.id !== 'cats')));

    expect(await removed.retrieve('domestic canines', { topK: 5 })).toEqual(
      await fresh.retrieve('domestic canines', { topK: 5 }),
    );
  });

  it('clear() empties the index', async () => {
    const keyword = new KeywordRetriever();
    keyword.add(chunkDocuments(DOCS));

    keyword.clear();

    expect(keyword.size).toBe(0);
    expect(await keyword.retrieve('domestic', { topK: 5 })).toEqual([]);
    // and it is reusable afterwards — the corpus stats reset with it
    keyword.add(chunkDocuments(DOCS));
    expect(keyword.size).toBe(3);
  });
});

describe('HybridRetriever (RRF)', () => {
  it('fuses vector + keyword and dedupes by id', async () => {
    const embedder = new FakeEmbeddingProvider();
    const store = new MemoryVectorStore();
    const keyword = new KeywordRetriever();
    const chunks = chunkDocuments(DOCS);
    await ingestChunks(chunks, { embedder, store });
    keyword.add(chunks); // same chunk ids as the vector store → fusion lines them up

    const hybrid = new HybridRetriever([new EmbeddingRetriever(embedder, store), keyword]);
    const passages = await hybrid.retrieve('domestic felines that chase mice', { topK: 3 });

    expect(passages[0]?.id).toBe('cats#0');
    const ids = passages.map((passage) => passage.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  // Pins the range the docblock claims, so the claim cannot rot into a lie. This is the whole
  // argument for not thresholding a fused score: every value below sits in [0.0125, 0.0328]
  // regardless of whether the query was answerable, and the top hit for a nonsense query scores at
  // least as high as the top hit for a real one.
  it('scores only ever land in the rank-derived band, answerable query or not', async () => {
    const embedder = new FakeEmbeddingProvider();
    const store = new MemoryVectorStore();
    const keyword = new KeywordRetriever();
    const chunks = chunkDocuments(DOCS);
    await ingestChunks(chunks, { embedder, store });
    keyword.add(chunks);

    const hybrid = new HybridRetriever([new EmbeddingRetriever(embedder, store), keyword]);
    // defaults: k = 60, fetchTopK = 20, two unweighted legs
    const FLOOR = 1 / (60 + 20); // 0.0125 — last rank of one list only
    const CEILING = 2 / (60 + 1); // 0.0328 — rank 0 of both lists

    const answerable = await hybrid.retrieve('domestic felines that chase mice', { topK: 5 });
    const nonsense = await hybrid.retrieve('quarterly dining hall menu rotation', { topK: 5 });

    for (const passage of [...answerable, ...nonsense]) {
      expect(passage.score).toBeGreaterThanOrEqual(FLOOR);
      expect(passage.score).toBeLessThanOrEqual(CEILING);
    }
    // The corpus is about cats, rockets and dogs, so the second query is unanswerable — and it is
    // still answered, with a top score sitting in the same narrow band as the real one's. Which
    // ordering wins depends on whether the legs happen to agree, and agreement tracks nothing about
    // correctness: here they agree on the real answer, on flip's corpus they agreed on the absent
    // one. Either way there is no magnitude a floor could key on, which is the point.
    expect(nonsense.length).toBeGreaterThan(0);
    expect(nonsense[0]?.score).toBeGreaterThanOrEqual(FLOOR);
    expect(nonsense[0]?.score).toBeLessThanOrEqual(CEILING);
  });
});

describe('EmbeddingRetriever minScore (abstention)', () => {
  async function fixture() {
    const embedder = new FakeEmbeddingProvider();
    const store = new MemoryVectorStore();
    await ingestChunks(chunkDocuments(DOCS), { embedder, store });
    return { embedder, store };
  }

  it('returns nothing when every neighbour is below the floor', async () => {
    const { embedder, store } = await fixture();
    // A floor above any achievable similarity: the store still has three documents and the search
    // still finds its nearest neighbours — the point is that "nearest" stops being reported as a
    // match. Without this the caller gets topK confident passages for a corpus that answers nothing.
    const strict = new EmbeddingRetriever(embedder, store, { minScore: 1.1 });
    expect(await strict.retrieve('anything at all', { topK: 5 })).toEqual([]);
  });

  it('keeps everything at or above the floor, and drops only what is below', async () => {
    const { embedder, store } = await fixture();
    const unfiltered = await new EmbeddingRetriever(embedder, store).retrieve('domestic felines', {
      topK: 5,
    });
    expect(unfiltered.length).toBeGreaterThan(1);

    // Floor set to the second-best score: everything scoring at least that much survives, so the
    // boundary is inclusive and nothing above it is lost.
    const cutoff = unfiltered[1]?.score ?? 0;
    const floored = new EmbeddingRetriever(embedder, store, { minScore: cutoff });
    const kept = await floored.retrieve('domestic felines', { topK: 5 });

    expect(kept.length).toBeGreaterThanOrEqual(2);
    expect(kept.every((passage) => passage.score >= cutoff)).toBe(true);
    expect(kept.map((passage) => passage.id)).toEqual(
      unfiltered.filter((passage) => passage.score >= cutoff).map((passage) => passage.id),
    );
  });

  it('is off by default — an unset floor changes nothing', async () => {
    const { embedder, store } = await fixture();
    const withOptions = new EmbeddingRetriever(embedder, store, {});
    const without = new EmbeddingRetriever(embedder, store);
    expect(await withOptions.retrieve('domestic', { topK: 5 })).toEqual(
      await without.retrieve('domestic', { topK: 5 }),
    );
  });
});

describe('RerankingRetriever', () => {
  it('over-fetches, reranks, and truncates to topK', async () => {
    const embedder = new FakeEmbeddingProvider();
    const store = new MemoryVectorStore();
    await ingestChunks(chunkDocuments(DOCS), { embedder, store });

    const reranked = new RerankingRetriever(
      new EmbeddingRetriever(embedder, store),
      new FakeReranker(),
      { fetchTopK: 3 },
    );
    const passages = await reranked.retrieve('loyal domestic canines that bark', { topK: 1 });

    expect(passages).toHaveLength(1);
    expect(passages[0]?.id).toBe('dogs#0');
  });
});
