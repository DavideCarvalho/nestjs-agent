import { MemoryVectorStore } from '@dudousxd/nestjs-agent-rag';
import { FakeEmbeddingProvider } from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import type { MediaAttachEvent } from './media-events.js';
import { type MediaIngestionDeps, ingestMediaFile } from './media-ingestion.js';
import {
  type MediaRagReconcilerDeps,
  type MediaSource,
  reconcileMediaRag,
} from './media-rag-reconciler.js';
import { defaultTextExtractor } from './text-extractor.js';

const FILES: Record<string, Buffer> = {
  's3:docs/a.txt': Buffer.from('alpha document about refunds'),
  's3:docs/b.txt': Buffer.from('bravo document about shipping'),
  's3:docs/c.txt': Buffer.from('charlie document about returns'),
};

function attachEvent(overrides: Partial<MediaAttachEvent> = {}): MediaAttachEvent {
  const event: MediaAttachEvent = {
    id: 'media-1',
    ownerType: 'user',
    ownerId: 'alice',
    collection: 'kb',
    disk: 's3',
    path: 'docs/policy.txt',
    size: 42,
    mimeType: 'text/plain',
    ...overrides,
  };
  // Declared size defaults to the truth: ingestion stamps the REAL byte length as the fingerprint,
  // so a fixture that declares a size its bytes don't have is drift, and would (correctly) re-ingest.
  const bytes = FILES[`${event.disk}:${event.path}`];
  return bytes === undefined || overrides.size !== undefined
    ? event
    : { ...event, size: bytes.byteLength };
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

describe('reconcileMediaRag', () => {
  it('ingests media missing from the index and removes indexed orphans', async () => {
    const { deps, store } = buildDeps(FILES);
    const eventA = attachEvent({ id: 'a', path: 'docs/a.txt' });
    const eventB = attachEvent({ id: 'b', path: 'docs/b.txt' });
    const eventC = attachEvent({ id: 'c', path: 'docs/c.txt' });

    // Seed the index with a and c (b is not yet indexed).
    await ingestMediaFile(eventA, deps);
    await ingestMediaFile(eventC, deps);

    // Source of truth now holds a and b only: b is new, c is gone.
    const source: MediaSource = {
      listMedia: async () => [eventA, eventB],
    };
    const reconcilerDeps: MediaRagReconcilerDeps = { ...deps, source };

    const result = await reconcileMediaRag(
      { ownerType: 'user', ownerId: 'alice', collection: 'kb' },
      reconcilerDeps,
    );

    expect(result.ingested).toEqual(['b']);
    expect(result.reingested).toEqual([]);
    expect(result.removed).toEqual(['c']);
    expect((await store.listDocuments()).map((document) => document.id).sort()).toEqual(['a', 'b']);
  });

  it('is idempotent: a second run touches nothing', async () => {
    const { deps, store } = buildDeps(FILES);
    const eventA = attachEvent({ id: 'a', path: 'docs/a.txt' });
    const eventB = attachEvent({ id: 'b', path: 'docs/b.txt' });
    const eventC = attachEvent({ id: 'c', path: 'docs/c.txt' });

    await ingestMediaFile(eventA, deps);
    await ingestMediaFile(eventC, deps);

    const source: MediaSource = {
      listMedia: async () => [eventA, eventB],
    };
    const reconcilerDeps: MediaRagReconcilerDeps = { ...deps, source };
    const query = { ownerType: 'user', ownerId: 'alice', collection: 'kb' };

    await reconcileMediaRag(query, reconcilerDeps);
    const second = await reconcileMediaRag(query, reconcilerDeps);

    expect(second).toEqual({ ingested: [], reingested: [], removed: [] });
    expect((await store.listDocuments()).map((document) => document.id).sort()).toEqual(['a', 'b']);
  });

  it('re-ingests a document whose content (size) changed under a stable id', async () => {
    const files: Record<string, Buffer> = {
      's3:docs/a.txt': Buffer.from('the original short body'),
    };
    const { deps, store } = buildDeps(files);
    await ingestMediaFile(attachEvent({ id: 'a', path: 'docs/a.txt', size: 23 }), deps);

    // the file was replaced (new bytes, new size) while nobody was listening
    files['s3:docs/a.txt'] = Buffer.from('a completely different and much longer replacement body');
    const changed = attachEvent({ id: 'a', path: 'docs/a.txt', size: 55 });
    const source: MediaSource = { listMedia: async () => [changed] };

    const result = await reconcileMediaRag(
      { ownerType: 'user', ownerId: 'alice', collection: 'kb' },
      { ...deps, source },
    );

    expect(result).toEqual({ ingested: [], reingested: ['a'], removed: [] });
    const documents = await store.listDocuments();
    expect(documents).toHaveLength(1);
    expect(documents[0]?.metadata?.size).toBe(55);
  });

  it('compares the fingerprint against statFile, not the declared size, when statFile is wired', async () => {
    const files: Record<string, Buffer> = { 's3:docs/a.txt': Buffer.from('the original body') };
    const { deps, store } = buildDeps(files, {
      statFile: async (disk, path) => files[`${disk}:${path}`]?.byteLength ?? 0,
    });
    // the attach record's declared size is wrong (a client-supplied lie) and stays wrong
    const lying = attachEvent({ id: 'a', path: 'docs/a.txt', size: 0 });
    await ingestMediaFile(lying, deps);

    const source: MediaSource = { listMedia: async () => [lying] };
    const query = { ownerType: 'user', ownerId: 'alice', collection: 'kb' };

    // real-vs-real: no phantom drift, so no re-ingest churn on every pass
    expect(await reconcileMediaRag(query, { ...deps, source })).toEqual({
      ingested: [],
      reingested: [],
      removed: [],
    });
    expect((await store.listDocuments())[0]?.metadata?.size).toBe(17);
  });
});
