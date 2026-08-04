import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import type { Passage, RetrieveOptions, Retriever } from '@dudousxd/nestjs-agent-core';
import { FakeEmbeddingProvider, FakeReranker } from '@dudousxd/nestjs-agent-testing';
import { afterEach, describe, expect, it } from 'vitest';
import { EmbeddingRetriever } from './embedding-retriever.js';
import { FilteredRetriever } from './filtered-retriever.js';
import { HybridRetriever } from './hybrid-retriever.js';
import { chunkDocuments, ingestChunks } from './ingest.js';
import { KeywordRetriever } from './keyword-retriever.js';
import { MemoryVectorStore } from './memory-vector-store.js';
import { PgVectorStore } from './pg-vector-store.js';
import { RedisVectorStore } from './redis-vector-store.js';
import { RerankingRetriever } from './reranking-retriever.js';
import { RAG_RETRIEVAL_CHANNEL, instrumentRetriever } from './retrieval-telemetry.js';
import { createRetrievalTool } from './retrieval-tool.js';

const DOCS = [
  { id: 'cats', text: 'Cats are domestic felines that purr and chase mice.', source: 'animals' },
  { id: 'rockets', text: 'Rockets burn propellant to reach orbit.', source: 'space' },
];

/** The envelope shape `@dudousxd/nestjs-diagnostics` publishes, narrowed structurally (no casts). */
interface CapturedEvent {
  durationMs?: number;
  payload: Record<string, unknown>;
}

function isCaptured(message: unknown): message is CapturedEvent {
  return (
    typeof message === 'object' &&
    message !== null &&
    typeof Reflect.get(message, 'payload') === 'object'
  );
}

let listener: ((message: unknown) => void) | undefined;

/** Subscribe to `aviary:rag:retrieval` and collect every envelope until `afterEach` detaches. */
function captureRetrievals(): CapturedEvent[] {
  const captured: CapturedEvent[] = [];
  listener = (message) => {
    if (isCaptured(message)) {
      captured.push(message);
    }
  };
  subscribe(RAG_RETRIEVAL_CHANNEL, listener);
  return captured;
}

afterEach(() => {
  if (listener !== undefined) {
    unsubscribe(RAG_RETRIEVAL_CHANNEL, listener);
    listener = undefined;
  }
});

async function memoryRetriever(): Promise<EmbeddingRetriever> {
  const embedder = new FakeEmbeddingProvider();
  const store = new MemoryVectorStore();
  await ingestChunks(chunkDocuments(DOCS), { embedder, store });
  return new EmbeddingRetriever(embedder, store);
}

/** A retriever that answers with whatever it was constructed with — no store, no describe. */
class StubRetriever implements Retriever {
  constructor(private readonly passages: Passage[]) {}
  async retrieve(_query: string, _options: RetrieveOptions = {}): Promise<Passage[]> {
    return this.passages;
  }
}

describe('instrumentRetriever', () => {
  it('publishes one event per retrieval, with the duration on the envelope', async () => {
    const captured = captureRetrievals();
    const retriever = instrumentRetriever(await memoryRetriever());

    const passages = await retriever.retrieve('domestic felines', { topK: 2 });

    expect(passages.length).toBeGreaterThan(0);
    expect(captured).toHaveLength(1);
    expect(captured[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(captured[0]?.payload).toMatchObject({
      retriever: 'embedding',
      store: 'memory',
      topK: 2,
      chunks: passages.length,
      zeroHit: false,
      failed: false,
    });
  });

  it('reports the score distribution of what the caller actually got back', async () => {
    const captured = captureRetrievals();
    const retriever = instrumentRetriever(
      new StubRetriever([
        { id: 'a', text: 'a', score: 0.9 },
        { id: 'b', text: 'b', score: 0.5 },
      ]),
    );

    await retriever.retrieve('anything');

    expect(captured[0]?.payload).toMatchObject({ topScore: 0.9, meanScore: 0.7 });
  });

  it('flags a zero-hit and carries no scores for it', async () => {
    const captured = captureRetrievals();
    const retriever = instrumentRetriever(new StubRetriever([]));

    await retriever.retrieve('nothing here');

    expect(captured[0]?.payload).toMatchObject({ chunks: 0, zeroHit: true });
    expect(captured[0]?.payload.topScore).toBeUndefined();
    expect(captured[0]?.payload.meanScore).toBeUndefined();
  });

  it('reports a throwing retrieval as failed and rethrows it unchanged', async () => {
    const captured = captureRetrievals();
    const boom = new Error('index unreachable');
    const retriever = instrumentRetriever({
      async retrieve(): Promise<Passage[]> {
        throw boom;
      },
    });

    await expect(retriever.retrieve('q')).rejects.toBe(boom);
    expect(captured[0]?.payload).toMatchObject({
      failed: true,
      error: 'index unreachable',
      zeroHit: true,
    });
  });

  it('is a pass-through when nothing is subscribed', async () => {
    // No captureRetrievals() here: the channel has no subscribers, which is the opt-out path.
    const base = await memoryRetriever();
    const instrumented = instrumentRetriever(base);

    expect(await instrumented.retrieve('domestic felines', { topK: 2 })).toEqual(
      await base.retrieve('domestic felines', { topK: 2 }),
    );
  });
});

describe('instrumentRetriever — composed retrievals', () => {
  it('reports ONE event for a composed retrieval, even when every layer is instrumented', async () => {
    const captured = captureRetrievals();
    const embedder = new FakeEmbeddingProvider();
    const store = new MemoryVectorStore();
    await ingestChunks(chunkDocuments(DOCS), { embedder, store });
    const keyword = new KeywordRetriever();
    keyword.add(chunkDocuments(DOCS));

    const retriever = instrumentRetriever(
      new RerankingRetriever(
        new HybridRetriever([
          instrumentRetriever(new EmbeddingRetriever(embedder, store)),
          instrumentRetriever(keyword),
        ]),
        new FakeReranker(),
      ),
    );

    await retriever.retrieve('domestic felines', { topK: 2 });

    expect(captured).toHaveLength(1);
    expect(captured[0]?.payload.retriever).toBe('reranking');
  });

  it('a leg retrieved on its own still reports — suppression is per call tree, not permanent', async () => {
    const captured = captureRetrievals();
    const leg = instrumentRetriever(await memoryRetriever());
    const composite = instrumentRetriever(new HybridRetriever([leg]));

    await composite.retrieve('domestic felines');
    await leg.retrieve('domestic felines');

    expect(captured.map((event) => event.payload.retriever)).toEqual(['hybrid', 'embedding']);
  });
});

describe('retrieval descriptors', () => {
  it('names the store and its namespace through every wrapper', async () => {
    const captured = captureRetrievals();
    const pg = new PgVectorStore({
      async query() {
        return [];
      },
    });
    const retriever = instrumentRetriever(
      new FilteredRetriever(new EmbeddingRetriever(new FakeEmbeddingProvider(), pg), {
        ownerId: 'u1',
      }),
    );

    await retriever.retrieve('q');

    expect(captured[0]?.payload).toMatchObject({
      retriever: 'filtered',
      store: 'pg',
      collection: 'agent_rag_chunks',
    });
  });

  it('keeps the shared store when a hybrid fuses two legs of the SAME index', async () => {
    const captured = captureRetrievals();
    const redis = new RedisVectorStore(
      {
        async sendCommand() {
          return [0];
        },
      },
      { index: 'kb_idx' },
    );
    const retriever = instrumentRetriever(
      new HybridRetriever([
        new EmbeddingRetriever(new FakeEmbeddingProvider(), redis),
        new EmbeddingRetriever(new FakeEmbeddingProvider(), redis),
      ]),
    );

    await retriever.retrieve('q');

    expect(captured[0]?.payload).toMatchObject({
      retriever: 'hybrid',
      store: 'redis',
      collection: 'kb_idx',
    });
  });

  it('drops the store when a hybrid fuses legs that disagree', async () => {
    const captured = captureRetrievals();
    const keyword = new KeywordRetriever();
    keyword.add(chunkDocuments(DOCS));
    const retriever = instrumentRetriever(
      new HybridRetriever([
        new EmbeddingRetriever(new FakeEmbeddingProvider(), new MemoryVectorStore()),
        keyword,
      ]),
    );

    await retriever.retrieve('q');

    expect(captured[0]?.payload.retriever).toBe('hybrid');
    expect(captured[0]?.payload.store).toBeUndefined();
  });

  it('falls back to `unknown` for a retriever from outside this package', async () => {
    const captured = captureRetrievals();

    await instrumentRetriever(new StubRetriever([])).retrieve('q');

    expect(captured[0]?.payload.retriever).toBe('unknown');
    expect(captured[0]?.payload.store).toBeUndefined();
  });

  it('lets the host name the collection off the call filter', async () => {
    const captured = captureRetrievals();
    const retriever = instrumentRetriever(await memoryRetriever(), {
      collection: (filter) =>
        typeof filter?.collectionId === 'string' ? filter.collectionId : undefined,
    });

    await retriever.retrieve('domestic felines', {
      filter: { collectionId: 'maintenance-policy' },
    });
    await retriever.retrieve('domestic felines', { filter: { collectionId: ['a', 'b'] } });

    expect(captured[0]?.payload.collection).toBe('maintenance-policy');
    // A multi-collection query has no single label; the store has no namespace either, so nothing.
    expect(captured[1]?.payload.collection).toBeUndefined();
  });
});

const TOOL_CTX = { actor: { id: 'u1' }, threadId: 't', runId: 'r', requestId: 'r' };

describe('createRetrievalTool telemetry', () => {
  it('instruments the retrieval it wraps by default', async () => {
    const captured = captureRetrievals();
    const tool = createRetrievalTool(await memoryRetriever(), { topK: 2 });

    await tool.handler.execute({ query: 'domestic felines' }, TOOL_CTX);

    expect(captured).toHaveLength(1);
    expect(captured[0]?.payload).toMatchObject({ retriever: 'embedding', topK: 2 });
  });

  it('emits nothing when the host opts out', async () => {
    const captured = captureRetrievals();
    const tool = createRetrievalTool(await memoryRetriever(), { telemetry: false });

    await tool.handler.execute({ query: 'domestic felines' }, TOOL_CTX);

    expect(captured).toEqual([]);
  });
});
