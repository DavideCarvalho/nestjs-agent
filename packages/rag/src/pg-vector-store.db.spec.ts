// Integration: PgVectorStore against a REAL pgvector Postgres (testcontainers). Proves the DDL,
// upsert/ON CONFLICT, cosine `<=>` ranking, and jsonb metadata filtering the MemoryVectorStore can't.
// Runs only under `pnpm test:db`.
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EmbeddingRetriever } from './embedding-retriever.js';
import { HybridRetriever } from './hybrid-retriever.js';
import { LexicalRetriever } from './lexical-retriever.js';
import type { PgClient } from './pg-vector-store.js';
import { PgLexicalVectorStore, PgVectorStore } from './pg-vector-store.js';
import { UnsafeRemovalError } from './vector-store.js';

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

/** The enumeration capability on its own table, so a destructive case can't reach the suite above. */
describe('PgVectorStore enumeration + bulk deletion (real pgvector)', () => {
  let enumStore: PgVectorStore;

  async function seed(): Promise<void> {
    await pool.query('TRUNCATE enum_chunks');
    await enumStore.upsert([
      { id: 'kb-a#0', text: 'kb a zero', embedding: [1, 0, 0], metadata: { collection: 'kb' } },
      { id: 'kb-a#1', text: 'kb a one', embedding: [1, 0, 0], metadata: { collection: 'kb' } },
      { id: 'kb-b#0', text: 'kb b zero', embedding: [1, 0, 0], metadata: { collection: 'kb' } },
      { id: 'ops-a#0', text: 'ops a zero', embedding: [0, 1, 0], metadata: { collection: 'ops' } },
      {
        id: 'bare',
        text: 'bare id',
        embedding: [0, 0, 1],
        metadata: { collection: 'ops', audience: ['public', 'role:ADMIN'] },
      },
    ]);
  }

  beforeAll(async () => {
    const client: PgClient = {
      query: (sql, params) => pool.query(sql, params).then((result) => result.rows),
    };
    enumStore = new PgVectorStore(client, { dimensions: 3, table: 'enum_chunks' });
    await enumStore.ensureSchema();
  });

  beforeEach(seed);

  it('countChunks and listDocumentIds agree with the metadata-carrying enumeration', async () => {
    expect(await enumStore.countChunks()).toBe(5);
    expect(await enumStore.countChunks({ collection: 'kb' })).toBe(3);
    expect(await enumStore.countChunks({ audience: ['role:ADMIN'] })).toBe(1);
    expect(await enumStore.listDocumentIds()).toEqual(['bare', 'kb-a', 'kb-b', 'ops-a']);
    expect(await enumStore.listDocumentIds({ collection: 'kb' })).toEqual(['kb-a', 'kb-b']);
    expect(await enumStore.listDocumentIds({ collection: [] })).toEqual([]);
  });

  it('listChunks reads one document back in order, bare id included, with paging', async () => {
    expect(await enumStore.listChunks('kb-a')).toEqual([
      { id: 'kb-a#0', index: 0, text: 'kb a zero', metadata: { collection: 'kb' } },
      { id: 'kb-a#1', index: 1, text: 'kb a one', metadata: { collection: 'kb' } },
    ]);
    // A bare id has no `#n` to extract; the COALESCE in CHUNK_INDEX_FROM_ID is what makes it 0
    // rather than NULL (which would sort last and read as "unknown position").
    expect(await enumStore.listChunks('bare')).toEqual([
      {
        id: 'bare',
        index: 0,
        text: 'bare id',
        metadata: { collection: 'ops', audience: ['public', 'role:ADMIN'] },
      },
    ]);
    expect((await enumStore.listChunks('kb-a', { limit: 1 })).map((c) => c.id)).toEqual(['kb-a#0']);
    expect((await enumStore.listChunks('kb-a', { offset: 1 })).map((c) => c.id)).toEqual([
      'kb-a#1',
    ]);
    // `kb` is a strict prefix of `kb-a`: the WHERE compares the DERIVED document id for equality, so
    // a prefix matches nothing. An unknown id is empty rather than an error.
    expect(await enumStore.listChunks('kb')).toEqual([]);
    expect(await enumStore.listChunks('nope')).toEqual([]);
  });

  it('listChunks orders numerically past ten, where ORDER BY id would not', async () => {
    await enumStore.upsert(
      [11, 10, 2, 1].map((index) => ({
        id: `wide#${index}`,
        text: `wide ${index}`,
        embedding: [1, 0, 0],
      })),
    );
    // Lexically `wide#10` < `wide#11` < `wide#2`; numerically 1 < 2 < 10 < 11. The cast to int is
    // the whole difference, and it only shows up once a document passes ten chunks.
    expect((await enumStore.listChunks('wide')).map((chunk) => chunk.index)).toEqual([
      1, 2, 10, 11,
    ]);
  });

  it('removeMany deletes N documents in one statement, bare ids included', async () => {
    await enumStore.removeMany(['kb-a', 'bare']);
    expect(await enumStore.listDocumentIds()).toEqual(['kb-b', 'ops-a']);
    await enumStore.removeMany([]);
    expect(await enumStore.countChunks()).toBe(2);
  });

  it('removeWhere scoped to one collection leaves the other intact', async () => {
    expect(await enumStore.removeWhere({ collection: 'kb' })).toBe(3);
    expect(await enumStore.countChunks({ collection: 'kb' })).toBe(0);
    expect(await enumStore.countChunks({ collection: 'ops' })).toBe(2);
  });

  it('DELETES NOTHING for an empty-array filter', async () => {
    expect(await enumStore.removeWhere({ audience: [] })).toBe(0);
    expect(await enumStore.removeWhere({ collection: 'kb', audience: [] })).toBe(0);
    expect(await enumStore.countChunks()).toBe(5);
  });

  it('refuses an empty filter object instead of truncating the table', async () => {
    await expect(enumStore.removeWhere({})).rejects.toBeInstanceOf(UnsafeRemovalError);
    expect(await enumStore.countChunks()).toBe(5);
  });
});

describe('PgVectorStore constructed from a Drizzle database (real pgvector)', () => {
  it('takes drizzle(pool) directly — no $client cast — and runs the iterative scan in a transaction', async () => {
    const db = drizzle(pool);
    const drizzleStore = new PgVectorStore(db, {
      dimensions: 3,
      table: 'drizzle_chunks',
      iterativeScan: 'strict_order',
      efSearch: 64,
    });
    await drizzleStore.ensureSchema();
    // One tenant is 1 row in 60: without the iterative scan an HNSW probe with a selective filter
    // can come back short. With it, the store keeps walking until topK rows pass.
    await drizzleStore.upsert(
      Array.from({ length: 60 }, (_, index) => ({
        id: `d${index}`,
        text: `row ${index}`,
        embedding: [1, index / 60, 0],
        metadata: { tenant: index % 20 === 0 ? 'rare' : 'common' },
      })),
    );

    const hits = await drizzleStore.search([1, 0, 0], { topK: 3, filter: { tenant: 'rare' } });
    expect(hits.map((hit) => hit.id)).toEqual(['d0', 'd20', 'd40']);
    // The SET LOCAL stayed inside the search's transaction.
    const [setting] = (await pool.query(`SELECT current_setting('hnsw.iterative_scan', true) AS v`))
      .rows as { v: string | null }[];
    expect(setting?.v ?? 'off').not.toBe('strict_order');
  });
});

describe('PgVectorStore batched upsert + nullable, mixed-dimension embeddings (real pgvector)', () => {
  let mixed: PgVectorStore;

  beforeAll(async () => {
    mixed = new PgVectorStore(pool, {
      dimensions: [2, 3],
      table: 'mixed_chunks',
      nullableEmbeddings: true,
      upsertBatchSize: 2,
    });
    await mixed.ensureSchema();
  });

  it('creates one partial HNSW index per listed width', async () => {
    const { rows } = await pool.query<{ indexname: string; indexdef: string }>(
      `SELECT indexname, indexdef FROM pg_indexes WHERE tablename = 'mixed_chunks' AND indexdef LIKE '%hnsw%' ORDER BY indexname`,
    );
    expect(rows.map((row) => row.indexname)).toEqual([
      'mixed_chunks_embedding_2_idx',
      'mixed_chunks_embedding_3_idx',
    ]);
    expect(rows[0]?.indexdef).toContain('WHERE (vector_dims(embedding) = 2)');
  });

  it('stores 2-wide, 3-wide and missing vectors side by side; search compares like with like', async () => {
    await mixed.upsert([
      { id: 'two-a', text: 'two a', embedding: [1, 0], metadata: { model: 'small' } },
      { id: 'two-b', text: 'two b', embedding: [0, 1], metadata: { model: 'small' } },
      { id: 'three-a', text: 'three a', embedding: [1, 0, 0], metadata: { model: 'large' } },
      { id: 'pending', text: 'not embedded yet', embedding: [] },
      { id: 'two-a', text: 'two a v2', embedding: [1, 0], metadata: { model: 'small' } },
    ]);

    expect(await mixed.countChunks()).toBe(4);
    const two = await mixed.search([1, 0], { topK: 10 });
    expect(two.map((hit) => hit.id)).toEqual(['two-a', 'two-b']);
    expect(two[0]?.text).toBe('two a v2');
    const three = await mixed.search([1, 0, 0], { topK: 10 });
    expect(three.map((hit) => hit.id)).toEqual(['three-a']);
    // A width with no index is still answered — exactly — and matches nothing here.
    expect(await mixed.search([1, 0, 0, 0], { topK: 10 })).toEqual([]);
  });

  it('strips NUL bytes through the batched statement', async () => {
    const NUL = String.fromCharCode(0);
    await mixed.upsert([
      { id: `nul${NUL}#0`, text: `a${NUL}b`, embedding: [1, 1], metadata: { k: `v${NUL}` } },
    ]);
    const [chunk] = await mixed.listChunks('nul');
    expect(chunk).toMatchObject({ id: 'nul#0', text: 'ab', metadata: { k: 'v' } });
  });
});

describe('PgLexicalVectorStore (real Postgres full-text search)', () => {
  let lexical: PgLexicalVectorStore;

  beforeAll(async () => {
    lexical = new PgLexicalVectorStore(pool, {
      dimensions: 3,
      table: 'lexical_chunks',
      nullableEmbeddings: true,
    });
    await lexical.ensureSchema();
    await lexical.upsert([
      {
        id: 'warranty#0',
        text: 'The solar panel warranty lasts twenty five years.',
        embedding: [1, 0, 0],
        metadata: { tenant: 't1' },
      },
      {
        id: 'install#0',
        text: 'Installation takes two days on a pitched roof.',
        embedding: [],
        metadata: { tenant: 't1' },
      },
      {
        id: 'other#0',
        text: 'Solar panel warranty for another tenant.',
        embedding: [],
        metadata: { tenant: 't2' },
      },
    ]);
  });

  it('builds a GIN index over the same expression it queries', async () => {
    const { rows } = await pool.query<{ indexdef: string }>(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'lexical_chunks_text_tsv_idx'`,
    );
    expect(rows[0]?.indexdef).toContain('USING gin (to_tsvector(');
  });

  it('finds chunks by words, filtered, including ones without an embedding', async () => {
    const hits = await lexical.searchText('solar warranty', { topK: 5, filter: { tenant: 't1' } });
    expect(hits.map((hit) => hit.id)).toEqual(['warranty#0']);
    const pending = await lexical.searchText('pitched roof', { topK: 5 });
    expect(pending.map((hit) => hit.id)).toEqual(['install#0']);
    // The vector leg never returns the un-embedded chunk.
    expect((await lexical.search([1, 0, 0], { topK: 5 })).map((hit) => hit.id)).toEqual([
      'warranty#0',
    ]);
  });

  it('falls back to any word for a long question that matches nothing as a whole', async () => {
    const hits = await lexical.searchText('how many years does the warranty on my inverter last', {
      topK: 5,
      filter: { tenant: 't1' },
    });
    expect(hits.map((hit) => hit.id)).toContain('warranty#0');
  });

  it("ranks the question's rare terms above its stop words", async () => {
    await lexical.upsert([
      {
        id: 'noise#0',
        text: 'The claims of the staff are in the office of the company, which is at the end of the road, and the time of the day is on the board.',
        embedding: [],
        metadata: { tenant: 't3' },
      },
      {
        id: 'gearbox#0',
        text: 'Warranty claims for turbine gearboxes go to the Denver depot.',
        embedding: [],
        metadata: { tenant: 't3' },
      },
      {
        id: 'expense#0',
        text: 'Expense claims are due by the 5th; claims without receipts are refused.',
        embedding: [],
        metadata: { tenant: 't3' },
      },
    ]);
    const ids = async (query: string) =>
      (await lexical.searchText(query, { topK: 5, filter: { tenant: 't3' } })).map((hit) => hit.id);
    // No row has every word; "the/of/which" used to rank the noise row first.
    expect((await ids('Which depot handles the warranty claims of the gearboxes?'))[0]).toBe(
      'gearbox#0',
    );
    // "claims" is in three rows, "gearboxes" in one: the rare term decides.
    expect((await ids('claims gearboxes'))[0]).toBe('gearbox#0');
    expect(await ids('"expense claims" -gearboxes')).toEqual(['expense#0']);
  });

  it('fuses with the dense leg in a HybridRetriever', async () => {
    const embedder = { embed: async (texts: string[]) => texts.map(() => [1, 0, 0]) };
    const retriever = new HybridRetriever([
      new EmbeddingRetriever(embedder, lexical),
      new LexicalRetriever(lexical),
    ]);
    const hits = await retriever.retrieve('pitched roof installation', { topK: 3 });
    expect(hits.map((hit) => hit.id)).toContain('install#0');
    expect(hits[0]?.id).toBeDefined();
  });
});
