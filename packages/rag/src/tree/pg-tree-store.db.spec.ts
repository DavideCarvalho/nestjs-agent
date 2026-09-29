// Integration: PgDocumentTreeStore against a real Postgres (testcontainers) — DDL, round trip,
// filters with the vector stores' semantics, unit ranges, replacement, NUL bytes, Drizzle client,
// and navigation end to end. Runs only under `pnpm test:db`.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { buildDocumentTree } from './build.js';
import { indexDocumentTree } from './index-document.js';
import { keywordTreeLlm } from './keyword-tree-llm.js';
import { TreeNavigationRetriever } from './navigate.js';
import { PgDocumentTreeStore } from './pg-tree-store.js';

let container: StartedPostgreSqlContainer;
let pool: Pool;
let store: PgDocumentTreeStore;

const pages = [
  '# Scope\nThis regulation applies to federal construction contracts.',
  '# Bonds\nPerformance bonds are required above the threshold.',
  'Payment bonds protect suppliers of labor and material.',
  '# Insurance\nThe contractor shall maintain liability insurance.',
];

beforeAll(async () => {
  container = await new PostgreSqlContainer('pgvector/pgvector:pg16')
    .withName(`nestjs-agent-tree-store-${process.pid}-${Date.now()}`)
    .start();
  pool = new Pool({ connectionString: container.getConnectionUri() });
  // A Drizzle database, exactly as a host would pass it.
  store = new PgDocumentTreeStore(drizzle(pool), { table: 'test_trees' });
  await store.ensureSchema();
  await store.ensureSchema(); // idempotent
});

afterAll(async () => {
  await pool?.end();
  await container?.stop();
});

describe('PgDocumentTreeStore (real Postgres)', () => {
  it('round-trips a tree and its units, and reads unit ranges in order', async () => {
    const { tree, units } = await buildDocumentTree(
      { pages, title: 'Construction' },
      { documentId: 'doc-1', metadata: { tenant: 't1', audience: ['public'] }, source: 'c.pdf' },
    );
    await store.put(tree, units);
    const read = await store.get('doc-1');
    expect(read).toEqual(tree);
    expect((await store.readUnits('doc-1', 1, 2)).map((unit) => [unit.index, unit.page])).toEqual([
      [1, 2],
      [2, 3],
    ]);
    expect(await store.readUnits('missing', 0, 10)).toEqual([]);
  });

  it('filters with vector-store semantics: scalar, match-any (array metadata too), empty-array deny', async () => {
    const { tree, units } = await buildDocumentTree(
      { pages },
      { documentId: 'doc-2', metadata: { tenant: 't2', audience: ['staff', 'admin'] } },
    );
    await store.put(tree, units);
    expect(await store.get('doc-1', { tenant: 't1' })).toBeDefined();
    expect(await store.get('doc-1', { tenant: 't2' })).toBeUndefined();
    expect((await store.getMany(['doc-1', 'doc-2'], { tenant: ['t1', 't2'] })).length).toBe(2);
    expect(
      (await store.getMany(['doc-1', 'doc-2'], { audience: ['admin'] })).map((t) => t.documentId),
    ).toEqual(['doc-2']);
    expect(await store.getMany(['doc-1', 'doc-2'], { tenant: [] })).toEqual([]);
    expect(await store.list({ filter: { tenant: [] } })).toEqual([]);
    const headers = await store.list({ filter: { tenant: 't1' } });
    expect(headers.map((header) => [header.documentId, header.title, header.source])).toEqual([
      ['doc-1', 'Construction', 'c.pdf'],
    ]);
    expect((await store.list({ documentIds: ['doc-2', 'nope'] })).map((h) => h.documentId)).toEqual(
      ['doc-2'],
    );
    expect(await store.list({ limit: 1 })).toHaveLength(1);
  });

  it('replaces units on put (a shorter version leaves no tail), strips NUL bytes, and removes', async () => {
    const { tree, units } = await buildDocumentTree(
      { pages: ['# Only\nshort\u0000 text'] },
      { documentId: 'doc-2', metadata: { tenant: 't2' } },
    );
    await store.put(tree, units);
    const all = await store.readUnits('doc-2', 0, 100);
    expect(all.map((unit) => unit.text)).toEqual(['# Only\nshort text']);
    await store.remove('doc-2');
    expect(await store.get('doc-2')).toBeUndefined();
    expect(await store.readUnits('doc-2', 0, 100)).toEqual([]);
  });

  it('serves navigation end to end, with the tenant filter applied in SQL', async () => {
    const pgPool = new PgDocumentTreeStore(pool, { table: 'nav_trees' });
    await pgPool.ensureSchema();
    await indexDocumentTree(
      { pages, title: 'Construction' },
      { store: pgPool, documentId: 'reg', minUnits: 1, metadata: { tenant: 't1' } },
    );
    const navigator = new TreeNavigationRetriever({
      store: pgPool,
      llm: keywordTreeLlm(),
      maxNodes: 1,
    });
    const result = await navigator.navigate('payment bonds suppliers', ['reg'], {
      filter: { tenant: 't1' },
    });
    expect(result.passages[0]?.metadata).toMatchObject({
      title: 'Bonds',
      pageStart: 2,
      pageEnd: 3,
    });
    expect(result.passages[0]?.text).toContain('Payment bonds protect suppliers');
    const denied = await navigator.navigate('payment bonds', ['reg'], { filter: { tenant: 't9' } });
    expect(denied.passages).toEqual([]);
  });

  it('rejects an unsafe table name', () => {
    expect(() => new PgDocumentTreeStore(pool, { table: 'trees; DROP TABLE x' })).toThrow(
      /invalid table/,
    );
  });
});
