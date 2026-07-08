import { EmbeddingRetriever, MemoryVectorStore } from '@dudousxd/nestjs-agent-rag';
import { FakeEmbeddingProvider } from '@dudousxd/nestjs-agent-testing';
import { emit } from '@dudousxd/nestjs-diagnostics';
import { afterEach, describe, expect, it } from 'vitest';
import {
  type AgentMediaIngestionOptions,
  AgentMediaIngestionService,
} from './agent-media-ingestion.service.js';
import type { MediaAttachEvent } from './media-events.js';

// Drives the service over the REAL aviary:media:* diagnostics channels, exactly as
// @dudousxd/nestjs-media publishes them — proving the wire contract, not just the pure functions.

let running: AgentMediaIngestionService | undefined;

afterEach(async () => {
  await running?.onModuleDestroy();
  running = undefined;
});

function start(overrides: Partial<AgentMediaIngestionOptions> = {}) {
  const embedder = new FakeEmbeddingProvider();
  const store = new MemoryVectorStore();
  const files: Record<string, Buffer> = {
    's3:docs/policy.txt': Buffer.from('Refunds are issued within thirty days.'),
  };
  const options: AgentMediaIngestionOptions = {
    embedder,
    store,
    readFile: async (disk, path) => files[`${disk}:${path}`] ?? Buffer.from(''),
    ...overrides,
  };
  const service = new AgentMediaIngestionService(options);
  service.onModuleInit();
  running = service;
  return { service, embedder, store, files };
}

const attach: MediaAttachEvent = {
  id: 'media-1',
  ownerType: 'user',
  ownerId: 'alice',
  collection: 'knowledge-base',
  disk: 's3',
  path: 'docs/policy.txt',
  size: 38,
  mimeType: 'text/plain',
};

describe('AgentMediaIngestionModule (via the diagnostics channel)', () => {
  it('ingests a file emitted on aviary:media:attach, making it retrievable', async () => {
    const { service, embedder, store } = start();

    emit('media', 'attach', attach);
    await service.settle();

    const passages = await new EmbeddingRetriever(embedder, store).retrieve('refund', { topK: 5 });
    expect(passages[0]?.metadata).toMatchObject({ mediaId: 'media-1', ownerId: 'alice' });
  });

  it('removes the chunks when aviary:media:delete fires', async () => {
    const { service, embedder, store } = start();

    emit('media', 'attach', attach);
    await service.settle();
    emit('media', 'delete', { id: 'media-1', ownerType: 'user', ownerId: 'alice' });
    await service.settle();

    expect(await new EmbeddingRetriever(embedder, store).retrieve('refund', { topK: 5 })).toEqual(
      [],
    );
  });

  it('ignores attaches outside the configured collections', async () => {
    const { service, embedder, store } = start({ collections: ['knowledge-base'] });

    emit('media', 'attach', { ...attach, collection: 'avatars' });
    await service.settle();

    expect(await new EmbeddingRetriever(embedder, store).retrieve('refund', { topK: 5 })).toEqual(
      [],
    );
  });

  it('stops ingesting after onModuleDestroy unsubscribes', async () => {
    const { service, embedder, store } = start();
    await service.onModuleDestroy();
    running = undefined;

    emit('media', 'attach', attach);
    await service.settle();

    expect(await new EmbeddingRetriever(embedder, store).retrieve('refund', { topK: 5 })).toEqual(
      [],
    );
  });
});
