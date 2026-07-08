import { EmbeddingRetriever, MemoryVectorStore } from '@dudousxd/nestjs-agent-rag';
import { FakeEmbeddingProvider } from '@dudousxd/nestjs-agent-testing';
import { emit } from '@dudousxd/nestjs-diagnostics';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AgentMediaIngestionOptions,
  AgentMediaIngestionService,
  type MediaConversionIngestion,
} from './agent-media-ingestion.service.js';
import type { MediaAttachEvent, MediaConversionEvent } from './media-events.js';

// Drives the service over the real aviary:media:conversion channel, proving derived-artifact
// ingestion (PDF→text, OCR) — the media pipeline extracts, the RAG side just indexes the result.

let running: AgentMediaIngestionService | undefined;

afterEach(async () => {
  await running?.onModuleDestroy();
  running = undefined;
});

// Maps a `text` conversion of media `pdf-1` to the derived text artifact, under the SAME media id.
function textConversion(): MediaConversionIngestion {
  return {
    names: ['text'],
    resolve: (event: MediaConversionEvent): MediaAttachEvent => ({
      id: event.id,
      ownerType: 'user',
      ownerId: 'alice',
      collection: 'knowledge-base',
      disk: 's3',
      path: event.path,
      size: 1024,
      mimeType: 'text/plain',
    }),
  };
}

function start(files: Record<string, Buffer>, overrides: Partial<AgentMediaIngestionOptions> = {}) {
  const embedder = new FakeEmbeddingProvider();
  const store = new MemoryVectorStore();
  const options: AgentMediaIngestionOptions = {
    embedder,
    store,
    readFile: async (disk, path) => files[`${disk}:${path}`] ?? Buffer.from(''),
    ...overrides,
  };
  const service = new AgentMediaIngestionService(options);
  service.onModuleInit();
  running = service;
  return { service, embedder, store };
}

describe('conversion ingestion', () => {
  it('ingests a converted text artifact under the media id', async () => {
    const { service, embedder, store } = start(
      { 's3:conv/pdf-1.txt': Buffer.from('Extracted invoice total is four hundred dollars.') },
      { conversions: textConversion() },
    );

    emit('media', 'conversion', { id: 'pdf-1', conversion: 'text', path: 'conv/pdf-1.txt' });
    await service.settle();

    const passages = await new EmbeddingRetriever(embedder, store).retrieve('invoice total', {
      topK: 5,
    });
    expect(passages[0]?.metadata).toMatchObject({ mediaId: 'pdf-1', ownerId: 'alice' });
  });

  it('ignores conversions whose name is not configured', async () => {
    const { service, embedder, store } = start(
      { 's3:conv/pdf-1.png': Buffer.from('thumbnail bytes') },
      { conversions: textConversion() },
    );

    emit('media', 'conversion', { id: 'pdf-1', conversion: 'thumbnail', path: 'conv/pdf-1.png' });
    await service.settle();

    expect(await new EmbeddingRetriever(embedder, store).retrieve('anything', { topK: 5 })).toEqual(
      [],
    );
  });

  it('does not subscribe to conversions when none are configured', async () => {
    const { service, embedder, store } = start({
      's3:conv/pdf-1.txt': Buffer.from('should not be ingested'),
    });

    emit('media', 'conversion', { id: 'pdf-1', conversion: 'text', path: 'conv/pdf-1.txt' });
    await service.settle();

    expect(await new EmbeddingRetriever(embedder, store).retrieve('anything', { topK: 5 })).toEqual(
      [],
    );
  });

  it('a skipped binary original does not wipe conversion-derived chunks (same document id)', async () => {
    const { service, embedder, store } = start(
      {
        's3:docs/pdf-1.pdf': Buffer.from([0x25, 0x50, 0x44, 0x46]), // "%PDF" — unsupported binary
        's3:conv/pdf-1.txt': Buffer.from('the quarterly report body text'),
      },
      { conversions: textConversion() },
    );

    // conversion ingested first
    emit('media', 'conversion', { id: 'pdf-1', conversion: 'text', path: 'conv/pdf-1.txt' });
    await service.settle();
    // then the binary original (re-)attaches — unsupported, skipped, and must NOT remove
    emit('media', 'attach', {
      id: 'pdf-1',
      ownerType: 'user',
      ownerId: 'alice',
      collection: 'knowledge-base',
      disk: 's3',
      path: 'docs/pdf-1.pdf',
      size: 4,
      mimeType: 'application/pdf',
    });
    await service.settle();

    const passages = await new EmbeddingRetriever(embedder, store).retrieve('quarterly report', {
      topK: 5,
    });
    expect(passages[0]?.metadata).toMatchObject({ mediaId: 'pdf-1' });
  });
});
