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
