import { FakeEmbeddingProvider } from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import { chunkText } from './chunk.js';
import { EmbeddingRetriever } from './embedding-retriever.js';
import { FilteredRetriever } from './filtered-retriever.js';
import { chunkDocuments, ingestChunks, ingestDocuments } from './ingest.js';
import { MemoryVectorStore } from './memory-vector-store.js';
import { createRetrievalTool } from './retrieval-tool.js';

describe('chunkText', () => {
  it('returns the whole text as one chunk when under the size limit', () => {
    expect(chunkText('short text', { chunkSize: 100 })).toEqual(['short text']);
  });

  it('returns nothing for blank input', () => {
    expect(chunkText('   ')).toEqual([]);
  });

  it('splits long text into overlapping chunks that each stay near the size limit', () => {
    const text = Array.from({ length: 50 }, (_, index) => `sentence number ${index}.`).join(' ');
    const chunks = chunkText(text, { chunkSize: 120, overlap: 30 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(120);
    }
    // reassembled coverage: every sentence marker survives somewhere
    expect(chunks.join(' ')).toContain('sentence number 49.');
  });
});

describe('ingest + retrieve (MemoryVectorStore + EmbeddingRetriever)', () => {
  async function buildRetriever() {
    const embedder = new FakeEmbeddingProvider();
    const store = new MemoryVectorStore();
    const written = await ingestDocuments(
      [
        {
          id: 'doc-cats',
          text: 'Cats are small domestic felines that purr and chase mice.',
          source: 'animals/cats',
        },
        {
          id: 'doc-rockets',
          text: 'Rockets burn propellant to reach orbit and escape gravity.',
          source: 'space/rockets',
        },
      ],
      { embedder, store, chunkSize: 200 },
    );
    return { retriever: new EmbeddingRetriever(embedder, store), written };
  }

  it('ranks the topically-matching passage first', async () => {
    const { retriever, written } = await buildRetriever();
    expect(written).toBe(2);
    const passages = await retriever.retrieve('domestic feline that chases mice', { topK: 2 });
    expect(passages[0]?.source).toBe('animals/cats');
  });

  it('honours topK', async () => {
    const { retriever } = await buildRetriever();
    expect(await retriever.retrieve('anything', { topK: 1 })).toHaveLength(1);
  });

  it('re-ingesting a document overwrites its chunks (deterministic ids), no duplicates', async () => {
    const embedder = new FakeEmbeddingProvider();
    const store = new MemoryVectorStore();
    await ingestDocuments([{ id: 'd', text: 'first version' }], { embedder, store });
    await ingestDocuments([{ id: 'd', text: 'second version' }], { embedder, store });
    const passages = await retriever(embedder, store);
    expect(passages).toHaveLength(1);
    expect(passages[0]?.text).toBe('second version');
  });

  async function retriever(
    embedder: FakeEmbeddingProvider,
    store: MemoryVectorStore,
  ): ReturnType<EmbeddingRetriever['retrieve']> {
    return new EmbeddingRetriever(embedder, store).retrieve('version', { topK: 10 });
  }
});

describe('MemoryVectorStore.remove', () => {
  it('drops every chunk of a document and nothing else', async () => {
    const embedder = new FakeEmbeddingProvider();
    const store = new MemoryVectorStore();
    // small chunkSize so each doc becomes several chunks (ids `${id}#0`, `${id}#1`, …)
    await ingestDocuments(
      [
        { id: 'keep', text: 'alpha beta gamma delta epsilon zeta eta theta' },
        { id: 'drop', text: 'one two three four five six seven eight nine ten' },
      ],
      { embedder, store, chunkSize: 20, overlap: 0 },
    );

    await store.remove('drop');

    const passages = await new EmbeddingRetriever(embedder, store).retrieve('anything', {
      topK: 100,
    });
    expect(passages.length).toBeGreaterThan(0);
    expect(passages.every((passage) => passage.id.startsWith('keep#'))).toBe(true);
  });

  it('leaves no orphan when a re-ingested document shrinks to fewer chunks', async () => {
    const embedder = new FakeEmbeddingProvider();
    const store = new MemoryVectorStore();
    await ingestChunks(
      chunkDocuments([{ id: 'd', text: 'aaa bbb ccc ddd eee fff' }], { chunkSize: 12, overlap: 0 }),
      { embedder, store },
    );
    // re-ingest a much shorter version — remove first, then upsert
    await store.remove('d');
    await ingestChunks(chunkDocuments([{ id: 'd', text: 'tiny' }]), { embedder, store });

    const passages = await new EmbeddingRetriever(embedder, store).retrieve('anything', {
      topK: 100,
    });
    expect(passages).toHaveLength(1);
    expect(passages[0]?.text).toBe('tiny');
  });
});

describe('MemoryVectorStore.listDocuments', () => {
  it('returns distinct documents (chunks collapsed) with metadata, filtered by metadata', async () => {
    const embedder = new FakeEmbeddingProvider();
    const store = new MemoryVectorStore();
    await ingestDocuments(
      [
        { id: 'alice-1', text: 'a b c d e f g h', metadata: { owner: 'alice' } },
        { id: 'alice-2', text: 'more of alice content here', metadata: { owner: 'alice' } },
        { id: 'bob-1', text: 'bob content', metadata: { owner: 'bob' } },
      ],
      { embedder, store, chunkSize: 12, overlap: 0 },
    );

    const alice = await store.listDocuments({ owner: 'alice' });
    expect(alice.map((document) => document.id).sort()).toEqual(['alice-1', 'alice-2']);
    expect(alice.every((document) => document.metadata?.owner === 'alice')).toBe(true);
    expect(await store.listDocuments()).toHaveLength(3);
  });
});

describe('FilteredRetriever', () => {
  async function ownerScopedStore() {
    const embedder = new FakeEmbeddingProvider();
    const store = new MemoryVectorStore();
    await ingestDocuments(
      [
        { id: 'a-doc', text: 'shared topic sentence', metadata: { owner: 'alice' } },
        { id: 'b-doc', text: 'shared topic sentence', metadata: { owner: 'bob' } },
      ],
      { embedder, store },
    );
    return { base: new EmbeddingRetriever(embedder, store) };
  }

  it('only returns passages matching the fixed owner filter', async () => {
    const { base } = await ownerScopedStore();
    const scoped = new FilteredRetriever(base, { owner: 'alice' });
    const passages = await scoped.retrieve('shared topic', { topK: 10 });
    expect(passages.length).toBeGreaterThan(0);
    expect(passages.every((passage) => passage.metadata?.owner === 'alice')).toBe(true);
  });

  it('a caller cannot widen past the fixed scope', async () => {
    const { base } = await ownerScopedStore();
    const scoped = new FilteredRetriever(base, { owner: 'alice' });
    // caller tries to override the owner — fixed filter wins
    const passages = await scoped.retrieve('shared topic', { topK: 10, filter: { owner: 'bob' } });
    expect(passages.every((passage) => passage.metadata?.owner === 'alice')).toBe(true);
  });
});

describe('createRetrievalTool', () => {
  it('exposes a read tool whose handler returns retrieved passages', async () => {
    const embedder = new FakeEmbeddingProvider();
    const store = new MemoryVectorStore();
    await ingestDocuments([{ id: 'd', text: 'the quick brown fox', source: 'fox' }], {
      embedder,
      store,
    });
    const tool = createRetrievalTool(new EmbeddingRetriever(embedder, store));

    expect(tool.spec.kind).toBe('read');
    expect(tool.spec.name).toBe('search_knowledge');

    const result = await tool.handler.execute(
      { query: 'quick brown fox' },
      {
        actor: { id: 'u1' },
        threadId: 't',
        runId: 'r',
        requestId: 'r',
      },
    );
    expect(result).toMatchObject({ passages: [{ source: 'fox' }] });
  });

  it('rejects malformed input', async () => {
    const tool = createRetrievalTool(
      new EmbeddingRetriever(new FakeEmbeddingProvider(), new MemoryVectorStore()),
    );
    await expect(
      tool.handler.execute(
        { notQuery: 1 },
        {
          actor: { id: 'u1' },
          threadId: 't',
          runId: 'r',
          requestId: 'r',
        },
      ),
    ).rejects.toThrow(/query/);
  });
});
