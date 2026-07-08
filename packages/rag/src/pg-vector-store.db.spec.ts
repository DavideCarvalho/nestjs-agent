// Integration: PgVectorStore against a REAL pgvector Postgres (testcontainers). Proves the DDL,
// upsert/ON CONFLICT, cosine `<=>` ranking, and jsonb metadata filtering the MemoryVectorStore can't.
// Runs only under `pnpm test:db`.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { PgClient } from './pg-vector-store.js';
import { PgVectorStore } from './pg-vector-store.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let store: PgVectorStore;

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16').start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  const client: PgClient = {
    query: (sql, params) => pool.query(sql, params).then((result) => result.rows),
  };
  store = new PgVectorStore(client, { dimensions: 3, table: 'test_chunks' });
  await store.ensureSchema();
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe('PgVectorStore (real pgvector)', () => {
  it('upserts and ranks by cosine distance', async () => {
    await store.upsert([
      { id: 'a', text: 'about cats', embedding: [1, 0, 0], source: 'cats' },
      { id: 'b', text: 'about rockets', embedding: [0, 1, 0], source: 'rockets' },
    ]);

    const passages = await store.search([0.9, 0.1, 0], { topK: 2 });
    expect(passages).toHaveLength(2);
    expect(passages[0]?.source).toBe('cats');
    expect(passages[0]?.score).toBeGreaterThan(passages[1]?.score ?? 1);
  });

  it('ON CONFLICT overwrites a chunk in place', async () => {
    await store.upsert([{ id: 'a', text: 'v1', embedding: [1, 0, 0] }]);
    await store.upsert([{ id: 'a', text: 'v2', embedding: [1, 0, 0] }]);
    const passages = await store.search([1, 0, 0], { topK: 5 });
    expect(passages.filter((passage) => passage.id === 'a')).toHaveLength(1);
    expect(passages.find((passage) => passage.id === 'a')?.text).toBe('v2');
  });

  it('filters by jsonb metadata', async () => {
    await store.upsert([
      { id: 'x', text: 'tenant one', embedding: [0, 0, 1], metadata: { tenant: 't1' } },
      { id: 'y', text: 'tenant two', embedding: [0, 0, 1], metadata: { tenant: 't2' } },
    ]);
    const passages = await store.search([0, 0, 1], { topK: 5, filter: { tenant: 't1' } });
    expect(passages.every((passage) => passage.metadata?.tenant === 't1')).toBe(true);
    expect(passages.some((passage) => passage.id === 'x')).toBe(true);
  });

  it('remove() deletes every chunk of a document and leaves siblings untouched', async () => {
    await store.upsert([
      { id: 'del#0', text: 'part zero', embedding: [1, 0, 0] },
      { id: 'del#1', text: 'part one', embedding: [1, 0, 0] },
      { id: 'del', text: 'bare id', embedding: [1, 0, 0] },
      { id: 'delta#0', text: 'different document, shared prefix', embedding: [1, 0, 0] },
    ]);

    await store.remove('del');

    const passages = await store.search([1, 0, 0], { topK: 50 });
    const ids = passages.map((passage) => passage.id);
    expect(ids).not.toContain('del#0');
    expect(ids).not.toContain('del#1');
    expect(ids).not.toContain('del');
    // `delta#0` must survive — LIKE `del#%` must not match a different document id
    expect(ids).toContain('delta#0');
  });

  it('listDocuments() collapses chunk ids to distinct documents with metadata, filtered', async () => {
    await store.upsert([
      { id: 'list-doc-a#0', text: 'a zero', embedding: [1, 0, 0], metadata: { owner: 'u1' } },
      { id: 'list-doc-a#1', text: 'a one', embedding: [1, 0, 0], metadata: { owner: 'u1' } },
      { id: 'list-doc-b#0', text: 'b zero', embedding: [1, 0, 0], metadata: { owner: 'u2' } },
    ]);

    const u1 = await store.listDocuments({ owner: 'u1' });
    expect(u1.map((document) => document.id)).toEqual(['list-doc-a']);
    expect(u1[0]?.metadata?.owner).toBe('u1');

    const allIds = (await store.listDocuments()).map((document) => document.id);
    expect(allIds).toContain('list-doc-a');
    expect(allIds).toContain('list-doc-b');
  });
});
