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
});
