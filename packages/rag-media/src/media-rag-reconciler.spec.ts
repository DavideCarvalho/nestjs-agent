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

function attachEvent(overrides: Partial<MediaAttachEvent> = {}): MediaAttachEvent {
  return {
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
    const { deps, store } = buildDeps({
      's3:docs/a.txt': Buffer.from('alpha document about refunds'),
      's3:docs/b.txt': Buffer.from('bravo document about shipping'),
      's3:docs/c.txt': Buffer.from('charlie document about returns'),
    });
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
    expect(result.removed).toEqual(['c']);
    expect((await store.listDocumentIds()).sort()).toEqual(['a', 'b']);
  });

  it('is idempotent: a second run touches nothing', async () => {
    const { deps, store } = buildDeps({
      's3:docs/a.txt': Buffer.from('alpha document about refunds'),
      's3:docs/b.txt': Buffer.from('bravo document about shipping'),
      's3:docs/c.txt': Buffer.from('charlie document about returns'),
    });
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

    expect(second).toEqual({ ingested: [], removed: [] });
    expect((await store.listDocumentIds()).sort()).toEqual(['a', 'b']);
  });
});
