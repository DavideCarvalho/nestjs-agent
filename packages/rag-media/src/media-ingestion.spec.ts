import {
  EmbeddingRetriever,
  FilteredRetriever,
  MemoryVectorStore,
} from '@dudousxd/nestjs-agent-rag';
import { FakeEmbeddingProvider } from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it, vi } from 'vitest';
import type { MediaAttachEvent } from './media-events.js';
import { type MediaIngestionDeps, ingestMediaFile, removeMedia } from './media-ingestion.js';
import { defaultTextExtractor } from './text-extractor.js';

function attachEvent(overrides: Partial<MediaAttachEvent> = {}): MediaAttachEvent {
  return {
    id: 'media-1',
    ownerType: 'user',
    ownerId: 'alice',
    collection: 'knowledge-base',
    disk: 's3',
    path: 'docs/policy.txt',
    size: 42,
    mimeType: 'text/plain',
    ...overrides,
  };
}

function buildDeps(files: Record<string, Buffer>, overrides: Partial<MediaIngestionDeps> = {}) {
  const embedder = new FakeEmbeddingProvider();
  const store = new MemoryVectorStore();
  const deps: MediaIngestionDeps = {
    embedder,
    store,
    extractor: defaultTextExtractor(),
    readFile: async (disk, path) => {
      const bytes = files[`${disk}:${path}`];
      if (bytes === undefined) {
        throw new Error(`no file at ${disk}:${path}`);
      }
      return bytes;
    },
    ...overrides,
  };
  return { deps, embedder, store };
}

describe('ingestMediaFile', () => {
  it('extracts, chunks, embeds, and indexes an attached file with owner metadata', async () => {
    const { deps, embedder, store } = buildDeps({
      's3:docs/policy.txt': Buffer.from('Refunds are issued within thirty days of purchase.'),
    });

    const result = await ingestMediaFile(attachEvent(), deps);

    expect(result).toEqual({ status: 'ingested', chunks: 1 });
    const passages = await new EmbeddingRetriever(embedder, store).retrieve('refund policy', {
      topK: 5,
    });
    expect(passages[0]?.source).toBe('docs/policy.txt');
    expect(passages[0]?.metadata).toMatchObject({
      mediaId: 'media-1',
      ownerType: 'user',
      ownerId: 'alice',
      collection: 'knowledge-base',
    });
  });

  it('skips (does not index) an unsupported binary type', async () => {
    const { deps, store } = buildDeps({ 's3:x.bin': Buffer.from([1, 2, 3]) });
    const result = await ingestMediaFile(
      attachEvent({ path: 'x.bin', mimeType: 'application/octet-stream' }),
      deps,
    );
    expect(result).toEqual({ status: 'skipped', reason: 'unsupported-type' });
    expect(await new EmbeddingRetriever(deps.embedder, store).retrieve('x', { topK: 5 })).toEqual(
      [],
    );
  });

  it('skips an oversized file without reading it', async () => {
    const readFile = vi.fn(async () => Buffer.from('never read'));
    const { deps } = buildDeps({}, { readFile, maxBytes: 10 });
    const result = await ingestMediaFile(attachEvent({ size: 999 }), deps);
    expect(result).toEqual({ status: 'skipped', reason: 'too-large' });
    expect(readFile).not.toHaveBeenCalled();
  });

  it('skips a file whose REAL bytes are oversized even though it declared size 0', async () => {
    // `size` reaches this package from the attach record, which in most hosts is filled in by the
    // client that opened the upload session — so it can be a lie, and `0` walks past any limit.
    const oversized = Buffer.alloc(64, 'a');
    const extract = vi.fn(async () => 'should never be extracted');
    const { deps, store } = buildDeps(
      {},
      { readFile: async () => oversized, maxBytes: 10, extractor: { extract } },
    );

    const result = await ingestMediaFile(attachEvent({ size: 0 }), deps);

    expect(result).toEqual({ status: 'skipped', reason: 'too-large' });
    expect(extract).not.toHaveBeenCalled();
    expect(await store.listDocuments()).toEqual([]);
  });

  it('consults statFile (when wired) so an oversized object is never downloaded', async () => {
    const readFile = vi.fn(async () => Buffer.alloc(64, 'a'));
    const statFile = vi.fn(async () => 64);
    const { deps } = buildDeps({}, { readFile, statFile, maxBytes: 10 });

    const result = await ingestMediaFile(attachEvent({ size: 0 }), deps);

    expect(result).toEqual({ status: 'skipped', reason: 'too-large' });
    expect(statFile).toHaveBeenCalledWith('s3', 'docs/policy.txt');
    expect(readFile).not.toHaveBeenCalled();
  });

  it('stamps the REAL byte length into chunk metadata when the declared size disagrees', async () => {
    const bytes = Buffer.from('Refunds are issued within thirty days.');
    const { deps, store } = buildDeps({ 's3:docs/policy.txt': bytes });

    // the attach record claims 0; the fingerprint the reconciler compares must not inherit that
    await ingestMediaFile(attachEvent({ size: 0 }), deps);

    const [document] = await store.listDocuments();
    expect(document?.metadata?.size).toBe(bytes.byteLength);
  });

  it('skips a file whose extracted text is blank', async () => {
    const { deps } = buildDeps({ 's3:docs/policy.txt': Buffer.from('   \n\t ') });
    expect(await ingestMediaFile(attachEvent(), deps)).toEqual({
      status: 'skipped',
      reason: 'empty-text',
    });
  });

  it('re-ingesting a shrunk document leaves no orphan chunks', async () => {
    const { deps, embedder, store } = buildDeps({
      's3:docs/policy.txt': Buffer.from('alpha beta gamma delta epsilon zeta'),
    });
    await ingestMediaFile(attachEvent({ mimeType: 'text/plain' }), {
      ...deps,
      chunk: { chunkSize: 12, overlap: 0 },
    });
    // second attach of the same media id, now much shorter
    const files: Record<string, Buffer> = { 's3:docs/policy.txt': Buffer.from('tiny') };
    await ingestMediaFile(attachEvent(), {
      ...deps,
      readFile: async (disk, path) => files[`${disk}:${path}`] ?? Buffer.from(''),
    });

    const passages = await new EmbeddingRetriever(embedder, store).retrieve('anything', {
      topK: 100,
    });
    expect(passages).toHaveLength(1);
    expect(passages[0]?.text).toBe('tiny');
  });
});

describe('removeMedia', () => {
  it('drops every chunk of a deleted media record', async () => {
    const { deps, embedder, store } = buildDeps({
      's3:docs/policy.txt': Buffer.from('some indexed content here'),
    });
    await ingestMediaFile(attachEvent(), deps);

    await removeMedia({ id: 'media-1', ownerType: 'user', ownerId: 'alice' }, { store });

    expect(await new EmbeddingRetriever(embedder, store).retrieve('content', { topK: 5 })).toEqual(
      [],
    );
  });
});

describe('owner-scoped retrieval (FilteredRetriever over ingested media)', () => {
  it("only surfaces the querying owner's documents", async () => {
    const { deps, embedder, store } = buildDeps({
      's3:alice.txt': Buffer.from('the quarterly revenue report'),
      's3:bob.txt': Buffer.from('the quarterly revenue report'),
    });
    await ingestMediaFile(attachEvent({ id: 'a', ownerId: 'alice', path: 'alice.txt' }), deps);
    await ingestMediaFile(attachEvent({ id: 'b', ownerId: 'bob', path: 'bob.txt' }), deps);

    const base = new EmbeddingRetriever(embedder, store);
    const forAlice = new FilteredRetriever(base, { ownerId: 'alice' });
    const passages = await forAlice.retrieve('quarterly revenue', { topK: 10 });

    expect(passages.length).toBeGreaterThan(0);
    expect(passages.every((passage) => passage.metadata?.ownerId === 'alice')).toBe(true);
  });
});
