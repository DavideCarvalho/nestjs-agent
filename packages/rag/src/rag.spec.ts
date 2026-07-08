import { FakeEmbeddingProvider } from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import { chunkText } from './chunk.js';
import { EmbeddingRetriever } from './embedding-retriever.js';
import { ingestDocuments } from './ingest.js';
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
