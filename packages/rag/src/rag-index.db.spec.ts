import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/node-postgres';
import { pgTable, serial, text, uuid } from 'drizzle-orm/pg-core';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PgVectorStore } from './pg-vector-store.js';
import { RagIndex, RagScopeRequiredError, anyOf } from './rag-index.js';

const documents = pgTable('rag_docs', {
  id: serial('id').primaryKey(),
  projectId: uuid('project_id').notNull(),
  title: text('title').notNull(),
  body: text('body'),
});
type Row = typeof documents.$inferSelect;
const P1 = '11111111-1111-1111-1111-111111111111';
const P2 = '22222222-2222-2222-2222-222222222222';
const embedder = { embed: async (t: string[]) => t.map(() => [1, 0, 0]) };
const definition = {
  name: 'rag_docs',
  id: (d: Row) => d.id,
  text: (d: Row) => d.body,
  source: (d: Row) => d.title,
  scope: { projectId: (d: Row) => d.projectId },
};

describe('RagIndex + Drizzle (real pgvector)', () => {
  let container: StartedPostgreSqlContainer;
  let pool: pg.Pool;

  beforeAll(async () => {
    container = await new PostgreSqlContainer('pgvector/pgvector:pg17').start();
    pool = new pg.Pool({ connectionString: container.getConnectionUri() });
    await pool.query(
      'create table rag_docs (id serial primary key, project_id uuid not null, title text not null, body text)',
    );
  }, 180_000);

  afterAll(async () => {
    await pool.end();
    await container.stop();
  });

  for (const vectorType of ['vector', 'halfvec'] as const) {
    it(`isolates, removes and reconciles over ${vectorType}`, async () => {
      const db = drizzle(pool);
      await db.delete(documents);
      const store = new PgVectorStore(db, {
        table: `chunks_${vectorType}`,
        dimensions: 3,
        vectorType,
      });
      await store.ensureSchema();
      const rag = new RagIndex(definition, { store, embedder });
      const [one, two] = await db
        .insert(documents)
        .values([
          { projectId: P1, title: 'a', body: 'alpha' },
          { projectId: P2, title: 'b', body: 'beta' },
        ])
        .returning();
      await rag.index(one as Row);
      await rag.index(two as Row);

      const hits = await rag.search('q', { scope: { projectId: P1 } });
      expect(hits.map((h) => h.text)).toEqual(['alpha']);
      expect(hits[0]?.source).toBe('a');
      expect(await rag.search('q', { scope: { projectId: anyOf([P1, P2]) } })).toHaveLength(2);
      expect(await rag.search('q', { scope: { projectId: anyOf([]) } })).toEqual([]);
      await expect(rag.search('q', { scope: {} as never })).rejects.toBeInstanceOf(
        RagScopeRequiredError,
      );

      const [gone] = await db
        .delete(documents)
        .where(eq(documents.id, (one as Row).id))
        .returning();
      await rag.remove(gone as Row);
      expect(await store.listChunks(rag.documentId((one as Row).id))).toEqual([]);

      await pool.query('delete from rag_docs'); // no hook sees this, like ON DELETE CASCADE
      const live = (await db.select({ id: documents.id }).from(documents)).map((r) => r.id);
      expect((await rag.reconcile(live)).orphans).toEqual([rag.documentId((two as Row).id)]);
      expect(await store.countChunks()).toBe(0);
    });
  }

  it('replaceDocument rolls back whole when the write fails', async () => {
    const store = new PgVectorStore(pool, { table: 'atomic', dimensions: 3 });
    await store.ensureSchema();
    const rag = new RagIndex(definition, { store, embedder });
    const row = { id: 1, projectId: P1, title: 't', body: 'first' };
    await rag.index(row);
    await expect(
      store.replaceDocument(rag.documentId(1), [
        { id: `${rag.documentId(1)}#0`, text: 'x', embedding: [1, 0] }, // wrong width
      ]),
    ).rejects.toThrow();
    expect((await store.listChunks(rag.documentId(1)))[0]?.text).toBe('first');
  });

  it('concurrent replaceDocument calls leave exactly one version, without deadlocks', async () => {
    const store = new PgVectorStore(pool, { table: 'race', dimensions: 3 });
    await store.ensureSchema();
    for (let round = 0; round < 10; round++) {
      await Promise.all(
        Array.from({ length: 8 }, (_, writer) =>
          store.replaceDocument(
            'doc',
            Array.from({ length: 30 - writer * 3 }, (_, chunk) => ({
              id: `doc#${chunk}`,
              text: `writer-${writer}`,
              embedding: [1, 0, 0],
            })),
          ),
        ),
      );
      const chunks = await store.listChunks('doc');
      expect(new Set(chunks.map((chunk) => chunk.text)).size).toBe(1);
    }
  });

  it('halfvec gets an HNSW index past the 2000 dimensions vector stops at', async () => {
    const wide = new PgVectorStore(pool, {
      table: 'wide',
      dimensions: 3072,
      vectorType: 'halfvec',
    });
    await wide.ensureSchema();
    const { rows } = await pool.query(`select indexdef from pg_indexes where tablename = 'wide'`);
    expect(rows.map((r) => r.indexdef).join()).toContain('halfvec_cosine_ops');
    const narrow = new PgVectorStore(pool, { table: 'narrow', dimensions: 3072 });
    await expect(narrow.ensureSchema()).rejects.toThrow(/2000 dimensions/);
  });
});
