import { EmbeddingRetriever, MemoryVectorStore } from '@dudousxd/nestjs-agent-rag';
import { FakeEmbeddingProvider } from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import { AgentMediaIngestionService } from './agent-media-ingestion.service.js';
import type { MediaAttachEvent } from './media-events.js';
import { type MediaIngestJob, applyMediaIngestJob } from './media-ingest-job.js';
import type { MediaIngestionDeps, ReadFile } from './media-ingestion.js';
import { defaultTextExtractor } from './text-extractor.js';

const attachPayload: MediaAttachEvent = {
  id: 'media-1',
  ownerType: 'user',
  ownerId: 'alice',
  collection: 'knowledge-base',
  disk: 's3',
  path: 'docs/policy.txt',
  size: 38,
  mimeType: 'text/plain',
};

describe('AgentMediaIngestionService with an enqueue hook', () => {
  it('hands work to the queue instead of ingesting inline, then replays it durably', async () => {
    const embedder = new FakeEmbeddingProvider();
    const store = new MemoryVectorStore();
    const files: Record<string, Buffer> = {
      's3:docs/policy.txt': Buffer.from('Refunds are issued within thirty days.'),
    };
    const readFile: ReadFile = async (disk, path) => files[`${disk}:${path}`] ?? Buffer.from('');
    const jobs: MediaIngestJob[] = [];
    const enqueue = (job: MediaIngestJob): void => {
      jobs.push(job);
    };
    // The deps a host's durable workflow would rebuild to run the enqueued job.
    const deps: MediaIngestionDeps = {
      readFile,
      embedder,
      store,
      extractor: defaultTextExtractor(),
    };

    const service = new AgentMediaIngestionService({ embedder, store, readFile, enqueue });

    // Attach only enqueues — nothing is indexed inline.
    await service.handleAttach(attachPayload);
    expect(jobs).toEqual([{ type: 'ingest', event: attachPayload }]);
    expect(await new EmbeddingRetriever(embedder, store).retrieve('refund', { topK: 5 })).toEqual(
      [],
    );

    // Running the enqueued job (as the durable workflow would) makes it retrievable.
    const ingestJob = jobs[0];
    expect(ingestJob).toBeDefined();
    if (ingestJob === undefined) {
      throw new Error('expected an ingest job to have been enqueued');
    }
    await applyMediaIngestJob(ingestJob, deps);
    const passages = await new EmbeddingRetriever(embedder, store).retrieve('refund', { topK: 5 });
    expect(passages[0]?.metadata).toMatchObject({ mediaId: 'media-1', ownerId: 'alice' });

    // Delete also only enqueues; replaying it empties the store again.
    await service.handleDelete({
      id: attachPayload.id,
      ownerType: attachPayload.ownerType,
      ownerId: attachPayload.ownerId,
    });
    expect(jobs).toHaveLength(2);
    const removeJob = jobs[1];
    expect(removeJob).toEqual({
      type: 'remove',
      event: {
        id: attachPayload.id,
        ownerType: attachPayload.ownerType,
        ownerId: attachPayload.ownerId,
      },
    });
    if (removeJob === undefined) {
      throw new Error('expected a remove job to have been enqueued');
    }
    await applyMediaIngestJob(removeJob, deps);
    expect(await new EmbeddingRetriever(embedder, store).retrieve('refund', { topK: 5 })).toEqual(
      [],
    );
  });
});
