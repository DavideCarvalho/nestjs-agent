import { Injectable } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { type RedisClientType, createClient } from 'redis';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ragFilterableFields } from '../rag-index.js';
import { type RedisSearchClient, RedisVectorStore } from '../redis-vector-store.js';
import { RagModule, RagRepository } from './index.js';

interface Doc {
  id: number;
  projectId: string;
  body: string;
}

@Injectable()
class DocumentsRag extends RagRepository<Doc> {
  protected readonly name = 'doc';
  readonly scope = { projectId: (d: Doc) => d.projectId };
  id(d: Doc) {
    return d.id;
  }
  protected text(d: Doc) {
    return d.body;
  }
}

let container: StartedTestContainer;
let client: RedisClientType;

beforeAll(async () => {
  container = await new GenericContainer('redis/redis-stack-server:latest')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
  client = createClient({ url: `redis://${container.getHost()}:${container.getMappedPort(6379)}` });
  await client.connect();
}, 180_000);

afterAll(async () => {
  await client?.quit();
  await container?.stop();
});

it('isolates by scope on RediSearch', async () => {
  const store = new RedisVectorStore(client as unknown as RedisSearchClient, {
    dimensions: 2,
    filterableFields: ragFilterableFields('projectId'),
  });
  await store.ensureSchema();
  const app = await Test.createTestingModule({
    imports: [
      RagModule.forRoot({ store, embedder: { embed: async (t) => t.map(() => [1, 0]) } }),
      RagModule.forFeature([DocumentsRag]),
    ],
  }).compile();
  const rag = app.get(DocumentsRag);
  await rag.index({ id: 1, projectId: 'a', body: 'alpha' });
  await rag.index({ id: 2, projectId: 'b', body: 'beta' });

  const hits = await rag.search('q', { scope: { projectId: 'a' } });
  expect(hits.map((hit) => hit.id)).toEqual(['doc:1#0']);
  expect((await rag.reconcile([1])).orphans).toEqual(['doc:2']);
  expect(await rag.search('q', { scope: { projectId: 'b' } })).toEqual([]);
});
