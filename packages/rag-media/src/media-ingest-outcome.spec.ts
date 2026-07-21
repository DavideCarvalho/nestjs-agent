import { subscribe, unsubscribe } from 'node:diagnostics_channel';
import { MemoryVectorStore } from '@dudousxd/nestjs-agent-rag';
import { FakeEmbeddingProvider } from '@dudousxd/nestjs-agent-testing';
import { channelName } from '@dudousxd/nestjs-diagnostics';
import { afterEach, describe, expect, it } from 'vitest';
import type { MediaAttachEvent } from './media-events.js';
import { runMediaIngestJob } from './media-ingest-job.js';
import { ingestMediaFile } from './media-ingestion.js';
import { MimeTextExtractor } from './text-extractor.js';

const EVENT: MediaAttachEvent = {
  id: 'doc-1',
  ownerType: 'user',
  ownerId: 'u1',
  collection: 'knowledge-base',
  disk: 'docs',
  path: 'notes.txt',
  size: 11,
  mimeType: 'text/plain',
};

const listeners: { channel: string; fn: (message: unknown) => void }[] = [];

/** Collect the payloads published on one `aviary:rag:*` channel. */
function capture(event: string): Record<string, unknown>[] {
  const seen: Record<string, unknown>[] = [];
  const channel = channelName('rag', event);
  const fn = (message: unknown) => {
    const payload = (message as { payload?: Record<string, unknown> })?.payload;
    if (payload) seen.push(payload);
  };
  subscribe(channel, fn);
  listeners.push({ channel, fn });
  return seen;
}

function deps(extra?: Partial<Parameters<typeof ingestMediaFile>[1]>) {
  const store = new MemoryVectorStore();
  return {
    store,
    embedder: new FakeEmbeddingProvider(),
    readFile: async () => Buffer.from('hello world'),
    ...extra,
  };
}

afterEach(() => {
  for (const { channel, fn } of listeners.splice(0)) {
    unsubscribe(channel, fn);
  }
});

describe('skip diagnostics carry the collection', () => {
  it('attributes a too-large skip to its owner and collection', async () => {
    const skipped = capture('media.skipped');
    await ingestMediaFile(EVENT, deps({ maxBytes: 1 }));

    expect(skipped[0]).toMatchObject({
      mediaId: 'doc-1',
      ownerType: 'user',
      ownerId: 'u1',
      collection: 'knowledge-base',
      source: 'notes.txt',
      mimeType: 'text/plain',
      reason: 'too-large',
    });
  });

  it('attributes an unsupported-type skip the same way', async () => {
    const skipped = capture('media.skipped');
    // an extractor that knows only PDFs, fed a text/plain event
    await ingestMediaFile(EVENT, deps({ extractor: new MimeTextExtractor({}) }));

    expect(skipped[0]).toMatchObject({
      collection: 'knowledge-base',
      reason: 'unsupported-type',
    });
  });

  it('attributes an empty-text skip the same way', async () => {
    const skipped = capture('media.skipped');
    await ingestMediaFile(EVENT, deps({ readFile: async () => Buffer.from('   ') }));

    expect(skipped[0]).toMatchObject({
      collection: 'knowledge-base',
      reason: 'empty-text',
    });
  });
});

describe('runMediaIngestJob', () => {
  it('returns the ingest result and publishes nothing on the failure channel', async () => {
    const failed = capture('media.failed');
    const outcome = await runMediaIngestJob({ type: 'ingest', event: EVENT }, deps());

    expect(outcome).toEqual({ status: 'ingested', chunks: 1 });
    expect(failed).toHaveLength(0);
  });

  it('converts a thrown error into a failed outcome instead of propagating', async () => {
    const failed = capture('media.failed');
    const outcome = await runMediaIngestJob(
      { type: 'ingest', event: EVENT },
      deps({
        readFile: async () => {
          throw new Error('S3 connection reset');
        },
      }),
    );

    expect(outcome).toEqual({ status: 'failed', error: 'S3 connection reset' });
    // the whole point: a detached caller still leaves a trace of what failed and where
    expect(failed[0]).toMatchObject({
      mediaId: 'doc-1',
      collection: 'knowledge-base',
      source: 'notes.txt',
      error: 'S3 connection reset',
    });
  });

  it('reports a removal as its own outcome', async () => {
    const outcome = await runMediaIngestJob(
      { type: 'remove', event: { id: 'doc-1', ownerType: 'user', ownerId: 'u1' } },
      deps(),
    );

    expect(outcome).toEqual({ status: 'removed' });
  });

  it('still publishes a failure for a removal that throws', async () => {
    const failed = capture('media.failed');
    const store = new MemoryVectorStore();
    store.remove = async () => {
      throw new Error('index unavailable');
    };

    const outcome = await runMediaIngestJob(
      { type: 'remove', event: { id: 'doc-1', ownerType: 'user', ownerId: 'u1' } },
      { ...deps(), store },
    );

    expect(outcome).toEqual({ status: 'failed', error: 'index unavailable' });
    // a delete event knows its owner but not the collection — the payload reflects exactly that
    expect(failed[0]).toMatchObject({ mediaId: 'doc-1', ownerType: 'user', ownerId: 'u1' });
    expect(failed[0]).not.toHaveProperty('collection');
  });
});
