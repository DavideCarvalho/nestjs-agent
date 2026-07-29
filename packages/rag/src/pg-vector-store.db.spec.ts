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

  it('an array filter value is OR / set membership (incl. array metadata); empty array denies', async () => {
    await store.upsert([
      { id: 'or-x', text: 'tenant or-t1', embedding: [0, 0, 1], metadata: { tenant: 'or-t1' } },
      { id: 'or-y', text: 'tenant or-t2', embedding: [0, 0, 1], metadata: { tenant: 'or-t2' } },
      // array-valued metadata: this document carries both or-t2 and or-t3
      {
        id: 'or-z',
        text: 'tenant or-t2 and or-t3',
        embedding: [0, 0, 1],
        metadata: { tenant: ['or-t2', 'or-t3'] },
      },
    ]);

    const hits = await store.search([0, 0, 1], {
      topK: 50,
      filter: { tenant: ['or-t1', 'or-t3'] },
    });
    const ids = hits.map((passage) => passage.id);
    expect(ids).toContain('or-x'); // matches or-t1
    expect(ids).toContain('or-z'); // matches or-t3 via its array-valued metadata
    expect(ids).not.toContain('or-y'); // only or-t2 — not requested

    const denied = await store.search([0, 0, 1], { topK: 50, filter: { tenant: [] } });
    expect(denied).toEqual([]);
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

// updateMetadata is one jsonb statement here — `||` IS the shallow merge and `- text[]` the removal —
// so what needs proving against a real Postgres is that those operators mean what the API promises.
describe('PgVectorStore.updateMetadata (real jsonb)', () => {
  async function seed(): Promise<void> {
    await store.upsert([
      {
        id: 'um-doc#0',
        text: 'zero',
        embedding: [1, 0, 0],
        source: 'docs/policy',
        metadata: { owner: 'u1', bases: ['A', 'B'], title: 'quarterly' },
      },
      {
        id: 'um-doc#1',
        text: 'one',
        embedding: [1, 0, 0],
        source: 'docs/policy',
        metadata: { owner: 'u1', bases: ['A', 'B'], title: 'quarterly' },
      },
      // a different document sharing the `um-doc` prefix — must not be touched
      { id: 'um-docs#0', text: 'sibling', embedding: [1, 0, 0], metadata: { bases: ['A'] } },
    ]);
  }

  it('merges the patch into every chunk, replacing arrays wholesale, sparing prefix-siblings', async () => {
    await seed();
    expect(await store.updateMetadata('um-doc', { bases: ['B', 'C'] })).toBe(2);

    const found = await store.search([1, 0, 0], { topK: 50, filter: { bases: ['C'] } });
    expect(found.map((passage) => passage.id).sort()).toEqual(['um-doc#0', 'um-doc#1']);
    for (const passage of found) {
      expect(passage.metadata).toEqual({ owner: 'u1', bases: ['B', 'C'], title: 'quarterly' });
      expect(passage.source).toBe('docs/policy'); // text/source/embedding untouched
      expect(passage.text.length).toBeGreaterThan(0);
    }

    // the old value no longer matches the patched document — only the untouched sibling
    const old = await store.search([1, 0, 0], { topK: 50, filter: { bases: ['A'] } });
    expect(old.map((passage) => passage.id)).toEqual(['um-docs#0']);
  });

  it('removes a key on an explicit null and ignores undefined', async () => {
    expect(await store.updateMetadata('um-doc', { title: null, owner: undefined })).toBe(2);
    const [document] = await store.listDocuments({ bases: ['C'] });
    expect(document?.metadata).toEqual({ owner: 'u1', bases: ['B', 'C'] });
  });

  it('creates metadata on a chunk ingested without any', async () => {
    await store.upsert([{ id: 'um-bare', text: 'no metadata', embedding: [1, 0, 0] }]);
    expect(await store.updateMetadata('um-bare', { owner: 'u9' })).toBe(1);
    expect(await store.listDocuments({ owner: 'u9' })).toEqual([
      { id: 'um-bare', metadata: { owner: 'u9' } },
    ]);
  });

  it('returns 0 for an unknown document and for a patch that writes nothing', async () => {
    expect(await store.updateMetadata('never-ingested', { owner: 'u1' })).toBe(0);
    expect(await store.updateMetadata('um-doc', {})).toBe(0);
    expect(await store.updateMetadata('um-doc', { owner: undefined })).toBe(0);
  });
});
