// Integration: RedisVectorStore against a REAL RediSearch (Redis Stack via testcontainers). Proves
// FT.CREATE/HSET/FT.SEARCH KNN ranking + TAG metadata filtering — the parts a fake can't. Runs only
// under `pnpm test:db`.
import { type RedisClientType, createClient } from 'redis';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { RedisSearchClient } from './redis-vector-store.js';
import { RedisVectorStore } from './redis-vector-store.js';

let container: StartedTestContainer;
let client: RedisClientType;
let store: RedisVectorStore;

beforeAll(async () => {
  container = await new GenericContainer('redis/redis-stack-server:latest')
    .withExposedPorts(6379)
    .withWaitStrategy(Wait.forLogMessage(/Ready to accept connections/))
    .start();
  client = createClient({
    url: `redis://${container.getHost()}:${container.getMappedPort(6379)}`,
  });
  await client.connect();
  const search: RedisSearchClient = { sendCommand: (args) => client.sendCommand(args) };
  store = new RedisVectorStore(search, {
    dimensions: 3,
    index: 'test_idx',
    prefix: 'test:',
    filterableFields: ['tenant'],
  });
  await store.ensureSchema();
});

afterAll(async () => {
  await client?.quit();
  await container?.stop();
});

describe('RedisVectorStore (real RediSearch)', () => {
  it('upserts and ranks by cosine KNN', async () => {
    await store.upsert([
      { id: 'a', text: 'about cats', embedding: [1, 0, 0], source: 'cats' },
      { id: 'b', text: 'about rockets', embedding: [0, 1, 0], source: 'rockets' },
    ]);
    const passages = await store.search([0.9, 0.1, 0], { topK: 2 });
    expect(passages).toHaveLength(2);
    expect(passages[0]?.id).toBe('a');
    expect(passages[0]?.source).toBe('cats');
    expect(passages[0]?.score).toBeGreaterThan(passages[1]?.score ?? 1);
  });

  it('overwrites a chunk in place on re-upsert', async () => {
    await store.upsert([{ id: 'a', text: 'v1', embedding: [1, 0, 0] }]);
    await store.upsert([{ id: 'a', text: 'v2', embedding: [1, 0, 0] }]);
    const passages = await store.search([1, 0, 0], { topK: 5 });
    expect(passages.filter((passage) => passage.id === 'a')).toHaveLength(1);
    expect(passages.find((passage) => passage.id === 'a')?.text).toBe('v2');
  });

  it('filters by TAG metadata', async () => {
    await store.upsert([
      { id: 'x', text: 'tenant one', embedding: [0, 0, 1], metadata: { tenant: 't1' } },
      { id: 'y', text: 'tenant two', embedding: [0, 0, 1], metadata: { tenant: 't2' } },
    ]);
    const passages = await store.search([0, 0, 1], { topK: 5, filter: { tenant: 't1' } });
    expect(passages.some((passage) => passage.id === 'x')).toBe(true);
    expect(passages.every((passage) => passage.metadata?.tenant === 't1')).toBe(true);
  });

  it('remove() SCANs and deletes every chunk of a document, sparing prefix-siblings', async () => {
    await store.upsert([
      { id: 'gone#0', text: 'part zero', embedding: [1, 0, 0] },
      { id: 'gone#1', text: 'part one', embedding: [1, 0, 0] },
      { id: 'gone', text: 'bare id', embedding: [1, 0, 0] },
      { id: 'goner#0', text: 'different document, shared prefix', embedding: [1, 0, 0] },
    ]);

    await store.remove('gone');

    const passages = await store.search([1, 0, 0], { topK: 50 });
    const ids = passages.map((passage) => passage.id);
    expect(ids).not.toContain('gone#0');
    expect(ids).not.toContain('gone#1');
    expect(ids).not.toContain('gone');
    // `goner#0` shares the `gone` prefix but is a different document — the `#*` glob must spare it
    expect(ids).toContain('goner#0');
  });

  it('listDocumentIds collapses chunks to distinct document ids and honors filters', async () => {
    // unique tenant values so this test doesn't see rows the earlier TAG-filter test left in the
    // shared index (which used tenant t1/t2)
    await store.upsert([
      {
        id: 'ld-a#0',
        text: 'doc a chunk zero',
        embedding: [1, 0, 0],
        metadata: { tenant: 'ld-t1' },
      },
      {
        id: 'ld-a#1',
        text: 'doc a chunk one',
        embedding: [1, 0, 0],
        metadata: { tenant: 'ld-t1' },
      },
      {
        id: 'ld-b#0',
        text: 'doc b chunk zero',
        embedding: [1, 0, 0],
        metadata: { tenant: 'ld-t2' },
      },
    ]);

    expect(await store.listDocumentIds({ tenant: 'ld-t1' })).toEqual(['ld-a']);

    const allIds = (await store.listDocumentIds()).sort();
    expect(allIds).toContain('ld-a');
    expect(allIds).toContain('ld-b');
  });
});
