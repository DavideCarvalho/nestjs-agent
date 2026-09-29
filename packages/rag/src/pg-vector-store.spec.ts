// Unit: PgVectorStore must never hand Postgres a NUL byte (0x00) — `text`/`jsonb` columns reject it
// outright ("invalid byte sequence for encoding "UTF8": 0x00"), and text extracted from PDFs
// sometimes carries one even though Qdrant tolerates it. A fake PgClient captures the exact
// bindings sent to `query`, so these assert on the wire values without a real Postgres — the db
// suite (pg-vector-store.db.spec.ts) proves everything that needs a live engine.
import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from './pg-vector-store.js';
import { PgLexicalVectorStore, PgVectorStore } from './pg-vector-store.js';
import { isLexicalVectorStore } from './vector-store.js';

const NUL = String.fromCharCode(0);

/** Records every call made through `query`, answering with empty rows. */
function fakeClient(): { client: PgClient; calls: { sql: string; params: unknown[] }[] } {
  const calls: { sql: string; params: unknown[] }[] = [];
  const client: PgClient = {
    query: vi.fn(async (sql: string, params: unknown[] = []) => {
      calls.push({ sql, params });
      return [];
    }),
  };
  return { client, calls };
}

describe('PgVectorStore.upsert (NUL byte stripping)', () => {
  it('strips a NUL byte from id, text and source while keeping the rest of the text intact', async () => {
    const { client, calls } = fakeClient();
    const store = new PgVectorStore(client, { dimensions: 3 });

    await store.upsert([
      {
        id: `doc${NUL}1#0`,
        text: `hello${NUL}world`,
        source: `docs/${NUL}policy`,
        embedding: [1, 0, 0],
      },
    ]);

    expect(calls).toHaveLength(1);
    const [id, text, source] = calls[0]?.params ?? [];
    expect(id).toBe('doc1#0');
    expect(text).toBe('helloworld');
    expect(source).toBe('docs/policy');
    expect(String(id)).not.toContain(NUL);
    expect(String(text)).not.toContain(NUL);
    expect(String(source)).not.toContain(NUL);
  });

  it('strips NUL bytes from metadata values, nested object values, array items and object keys', async () => {
    const { client, calls } = fakeClient();
    const store = new PgVectorStore(client, { dimensions: 3 });

    await store.upsert([
      {
        id: 'doc-meta#0',
        text: 'clean text',
        embedding: [1, 0, 0],
        metadata: {
          [`ti${NUL}tle`]: `quarterly${NUL}report`,
          tags: [`a${NUL}1`, 'b2'],
          nested: { [`ow${NUL}ner`]: `u${NUL}1`, bases: [`A${NUL}`, 'B'] },
        },
      },
    ]);

    expect(calls).toHaveLength(1);
    const metadataParam = calls[0]?.params[3];
    expect(typeof metadataParam).toBe('string');
    expect(String(metadataParam)).not.toContain(NUL);
    const metadata = JSON.parse(metadataParam as string) as Record<string, unknown>;
    expect(metadata).toEqual({
      title: 'quarterlyreport',
      tags: ['a1', 'b2'],
      nested: { owner: 'u1', bases: ['A', 'B'] },
    });
  });

  it('leaves NUL-free records untouched', async () => {
    const { client, calls } = fakeClient();
    const store = new PgVectorStore(client, { dimensions: 3 });

    await store.upsert([
      {
        id: 'clean#0',
        text: 'no bad bytes here',
        source: 'docs/clean',
        embedding: [1, 0, 0],
        metadata: { owner: 'u1', tags: ['a', 'b'] },
      },
    ]);

    const [id, text, source, metadataParam] = calls[0]?.params ?? [];
    expect(id).toBe('clean#0');
    expect(text).toBe('no bad bytes here');
    expect(source).toBe('docs/clean');
    expect(JSON.parse(metadataParam as string)).toEqual({ owner: 'u1', tags: ['a', 'b'] });
  });
});

describe('PgVectorStore.updateMetadata (NUL byte stripping)', () => {
  it('strips NUL bytes from the patch values and keys it sends as the merge payload', async () => {
    const { client, calls } = fakeClient();
    const store = new PgVectorStore(client, { dimensions: 3 });

    await store.updateMetadata('doc', {
      [`ti${NUL}tle`]: `quarterly${NUL}report`,
      tags: [`a${NUL}1`, 'b2'],
    });

    expect(calls).toHaveLength(1);
    const [, setParam] = calls[0]?.params ?? [];
    expect(String(setParam)).not.toContain(NUL);
    expect(JSON.parse(setParam as string)).toEqual({
      title: 'quarterlyreport',
      tags: ['a1', 'b2'],
    });
  });

  it('strips NUL bytes from removed keys (explicit null values)', async () => {
    const { client, calls } = fakeClient();
    const store = new PgVectorStore(client, { dimensions: 3 });

    await store.updateMetadata('doc', { [`ow${NUL}ner`]: null });

    expect(calls).toHaveLength(1);
    const [, , removeParam] = calls[0]?.params ?? [];
    expect(removeParam).toEqual(['owner']);
    expect((removeParam as string[]).every((key) => !key.includes(NUL))).toBe(true);
  });

  it('strips a NUL byte from documentId, so it matches what upsert actually stored', async () => {
    const { client, calls } = fakeClient();
    const store = new PgVectorStore(client, { dimensions: 3 });

    await store.updateMetadata(`doc${NUL}1`, { owner: 'u1' });

    expect(calls).toHaveLength(1);
    const [documentIdParam] = calls[0]?.params ?? [];
    expect(documentIdParam).toBe('doc1');
  });
});

describe('PgVectorStore document-id bindings (NUL byte stripping)', () => {
  it('remove() strips a NUL byte from documentId', async () => {
    const { client, calls } = fakeClient();
    const store = new PgVectorStore(client, { dimensions: 3 });

    await store.remove(`doc${NUL}1`);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual(['doc1']);
  });

  it('listChunks() strips a NUL byte from documentId', async () => {
    const { client, calls } = fakeClient();
    const store = new PgVectorStore(client, { dimensions: 3 });

    await store.listChunks(`doc${NUL}1`);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.params[0]).toBe('doc1');
  });

  it('removeMany() strips a NUL byte from every documentId', async () => {
    const { client, calls } = fakeClient();
    const store = new PgVectorStore(client, { dimensions: 3 });

    await store.removeMany([`doc${NUL}1`, 'doc2']);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.params).toEqual([['doc1', 'doc2']]);
  });
});

describe('PgVectorStore metadata filter bindings (NUL byte stripping)', () => {
  it('search() strips a NUL byte from a scalar filter key and value', async () => {
    const { client, calls } = fakeClient();
    const store = new PgVectorStore(client, { dimensions: 3 });

    await store.search([1, 0, 0], {
      topK: 5,
      filter: { [`ten${NUL}ant`]: `t${NUL}1` },
    });

    expect(calls).toHaveLength(1);
    const [, , scalarParam] = calls[0]?.params ?? [];
    expect(String(scalarParam)).not.toContain(NUL);
    expect(JSON.parse(scalarParam as string)).toEqual({ tenant: 't1' });
  });

  it('search() strips a NUL byte from an array filter key and its values', async () => {
    const { client, calls } = fakeClient();
    const store = new PgVectorStore(client, { dimensions: 3 });

    await store.search([1, 0, 0], {
      topK: 5,
      filter: { [`aud${NUL}ience`]: [`a${NUL}1`, 'a2'] },
    });

    expect(calls).toHaveLength(1);
    const [, , keyParam, arrayParam] = calls[0]?.params ?? [];
    expect(keyParam).toBe('audience');
    expect(arrayParam).toEqual(['a1', 'a2']);
  });

  it('removeWhere() strips a NUL byte from the filter before it becomes a binding', async () => {
    const { client, calls } = fakeClient();
    const store = new PgVectorStore(client, { dimensions: 3 });

    await store.removeWhere({ [`ow${NUL}ner`]: `u${NUL}1` });

    expect(calls).toHaveLength(1);
    const [scalarParam] = calls[0]?.params ?? [];
    expect(String(scalarParam)).not.toContain(NUL);
    expect(JSON.parse(scalarParam as string)).toEqual({ owner: 'u1' });
  });
});

describe('PgVectorStore.upsert (plain-object walk boundary)', () => {
  it('leaves a Date metadata value untouched instead of collapsing it to {}', async () => {
    const { client, calls } = fakeClient();
    const store = new PgVectorStore(client, { dimensions: 3 });
    const when = new Date('2024-01-01T00:00:00.000Z');

    await store.upsert([{ id: 'doc#0', text: 'clean', embedding: [1, 0, 0], metadata: { when } }]);

    const metadataParam = calls[0]?.params[3];
    expect(JSON.parse(metadataParam as string)).toEqual({ when: when.toJSON() });
  });

  it('preserves a metadata key literally named "__proto__" as an ordinary data property', async () => {
    const { client, calls } = fakeClient();
    const store = new PgVectorStore(client, { dimensions: 3 });
    const metadata: Record<string, unknown> = {};
    Object.defineProperty(metadata, '__proto__', {
      value: `admin${NUL}`,
      enumerable: true,
      writable: true,
      configurable: true,
    });

    await store.upsert([{ id: 'doc#0', text: 'clean', embedding: [1, 0, 0], metadata }]);

    const metadataParam = calls[0]?.params[3];
    const parsed = JSON.parse(metadataParam as string) as Record<string, unknown>;
    expect(Object.prototype.hasOwnProperty.call(parsed, '__proto__')).toBe(true);
    expect(parsed.__proto__).toBe('admin');
  });
});

/** A fake PgClient with a transaction, answering `extversion` with `version`. */
function fakeTxClient(version = '0.8.0') {
  const calls: { sql: string; params: unknown[]; tx: boolean }[] = [];
  const make = (tx: boolean): PgClient =>
    ({
      query: vi.fn(async (sql: string, params: unknown[] = []) => {
        calls.push({ sql, params, tx });
        if (sql.includes('pg_extension')) {
          return [{ extversion: version }];
        }
        return [];
      }) as PgClient['query'],
      ...(tx
        ? {}
        : { transaction: async (work: (tx: PgClient) => Promise<unknown>) => work(make(true)) }),
    }) as PgClient;
  return { client: make(false), calls };
}

describe('PgVectorStore.upsert (batched)', () => {
  it('writes many records in one multi-row statement, 5 bindings per row', async () => {
    const { client, calls } = fakeClient();
    const store = new PgVectorStore(client, { dimensions: 3 });

    await store.upsert([
      { id: 'a#0', text: 'a', embedding: [1, 0, 0] },
      { id: 'a#1', text: 'b', embedding: [0, 1, 0], source: 's', metadata: { k: 1 } },
    ]);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain(
      '($1, $2, $3, $4::jsonb, $5::vector), ($6, $7, $8, $9::jsonb, $10::vector)',
    );
    expect(calls[0]?.params).toEqual([
      'a#0',
      'a',
      null,
      null,
      '[1,0,0]',
      'a#1',
      'b',
      's',
      '{"k":1}',
      '[0,1,0]',
    ]);
  });

  it('splits into upsertBatchSize-row statements', async () => {
    const { client, calls } = fakeClient();
    const store = new PgVectorStore(client, { dimensions: 1, upsertBatchSize: 2 });

    await store.upsert(['a', 'b', 'c', 'd', 'e'].map((id) => ({ id, text: id, embedding: [1] })));

    expect(calls.map((call) => call.params.length)).toEqual([10, 10, 5]);
  });

  it('collapses duplicate ids to the last occurrence, since one statement cannot touch a row twice', async () => {
    const { client, calls } = fakeClient();
    const store = new PgVectorStore(client, { dimensions: 1 });

    await store.upsert([
      { id: 'a', text: 'first', embedding: [1] },
      { id: 'b', text: 'only', embedding: [1] },
      { id: `a${NUL}`, text: 'last', embedding: [1] },
    ]);

    expect(calls).toHaveLength(1);
    const params = calls[0]?.params ?? [];
    expect(params.filter((_, index) => index % 5 === 0)).toEqual(['b', 'a']);
    expect(params[6]).toBe('last');
  });

  it('writes an empty embedding as NULL (a full-text-only chunk)', async () => {
    const { client, calls } = fakeClient();
    const store = new PgVectorStore(client, { dimensions: 3, nullableEmbeddings: true });

    await store.upsert([{ id: 'a', text: 'no vector yet', embedding: [] }]);

    expect(calls[0]?.params[4]).toBeNull();
  });
});

describe('PgVectorStore schema', () => {
  it('keeps the fixed-width DDL by default', () => {
    const store = new PgVectorStore({ query: async () => [] }, { dimensions: 3, table: 't' });
    const ddl = store.schemaStatements().join('\n');
    expect(ddl).toContain('embedding vector(3) NOT NULL');
    expect(ddl).toContain('CREATE INDEX IF NOT EXISTS t_embedding_idx');
    expect(ddl).not.toContain('tsvector');
  });

  it('a list of widths makes an untyped, nullable column with one partial HNSW index per width', () => {
    const store = new PgVectorStore(
      { query: async () => [] },
      { dimensions: [384, 1536], table: 't', nullableEmbeddings: true },
    );
    const ddl = store.schemaStatements().join('\n');
    expect(ddl).toMatch(/embedding vector\s*\n/);
    expect(ddl).not.toContain('NOT NULL\n');
    expect(ddl).toContain(
      'USING hnsw ((embedding::vector(384)) vector_cosine_ops)\n        WHERE vector_dims(embedding) = 384',
    );
    expect(ddl).toContain('t_embedding_1536_idx');
    expect(ddl).not.toContain('t_embedding_idx');
  });

  it('ensureSchema runs exactly schemaStatements()', async () => {
    const { client, calls } = fakeClient();
    const store = new PgLexicalVectorStore(client, { dimensions: 3, table: 't' });
    await store.ensureSchema();
    expect(calls.map((call) => call.sql)).toEqual(store.schemaStatements());
    expect(calls.at(-1)?.sql).toContain("USING gin (to_tsvector('simple'::regconfig, text))");
  });

  it('rejects a width that is not a positive integer', () => {
    expect(() => new PgVectorStore({ query: async () => [] }, { dimensions: [0] })).toThrow();
  });
});

describe('PgVectorStore.search (mixed dimensions, nullable, iterative scan)', () => {
  it('compares only same-width vectors, through the width index when there is one', async () => {
    const { client, calls } = fakeClient();
    const store = new PgVectorStore(client, { dimensions: [3], table: 't' });

    await store.search([1, 0, 0], { topK: 5, filter: { model: 'm' } });
    await store.search([1, 0], { topK: 5 });

    expect(calls[0]?.sql).toContain('(embedding::vector(3)) <=> $1::vector(3)');
    expect(calls[0]?.sql).toContain(
      'metadata @> $3::jsonb AND embedding IS NOT NULL AND vector_dims(embedding) = 3',
    );
    expect(calls[1]?.sql).toContain('ORDER BY embedding <=> $1::vector');
    expect(calls[1]?.sql).toContain('vector_dims(embedding) = 2');
  });

  it('keeps the fixed-width query unchanged, and skips NULL embeddings when they are allowed', async () => {
    const { client, calls } = fakeClient();
    await new PgVectorStore(client, { dimensions: 3 }).search([1, 0, 0], { topK: 5 });
    await new PgVectorStore(client, { dimensions: 3, nullableEmbeddings: true }).search([1, 0, 0], {
      topK: 5,
    });
    expect(calls[0]?.sql).not.toContain('WHERE');
    expect(calls[1]?.sql).toContain('WHERE embedding IS NOT NULL');
  });

  it('an empty query vector finds nothing without a round-trip', async () => {
    const { client, calls } = fakeClient();
    await expect(new PgVectorStore(client).search([], { topK: 5 })).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('SET LOCALs the iterative scan and ef_search inside one transaction on pgvector ≥ 0.8', async () => {
    const { client, calls } = fakeTxClient('0.8.1');
    const store = new PgVectorStore(client, {
      dimensions: 3,
      iterativeScan: 'strict_order',
      efSearch: 100,
    });

    await store.search([1, 0, 0], { topK: 5 });
    await store.search([1, 0, 0], { topK: 5 });

    expect(calls.map((call) => [call.tx, call.sql.split('\n')[0]?.trim()])).toEqual([
      [false, "SELECT extversion FROM pg_extension WHERE extname = 'vector'"],
      [true, "SELECT set_config('hnsw.iterative_scan', $1, true)"],
      [true, "SELECT set_config('hnsw.ef_search', $1, true)"],
      [true, 'SELECT id, text, source, metadata, 1 - (embedding <=> $1::vector) AS score'],
      [true, "SELECT set_config('hnsw.iterative_scan', $1, true)"],
      [true, "SELECT set_config('hnsw.ef_search', $1, true)"],
      [true, 'SELECT id, text, source, metadata, 1 - (embedding <=> $1::vector) AS score'],
    ]);
    expect(calls[1]?.params).toEqual(['strict_order']);
    expect(calls[2]?.params).toEqual(['100']);
  });

  it('skips the iterative scan on pgvector < 0.8 (where setting it is an error)', async () => {
    const { client, calls } = fakeTxClient('0.7.4');
    const store = new PgVectorStore(client, { dimensions: 3, iterativeScan: 'relaxed_order' });

    await store.search([1, 0, 0], { topK: 5 });

    expect(calls.some((call) => call.sql.includes('iterative_scan'))).toBe(false);
    expect(calls.at(-1)?.tx).toBe(false);
  });

  it('skips it too for a client without transactions', async () => {
    const { client, calls } = fakeClient();
    await new PgVectorStore(client, { dimensions: 3, iterativeScan: 'strict_order' }).search(
      [1, 0, 0],
      { topK: 5 },
    );
    expect(calls).toHaveLength(1);
  });
});

describe('PgLexicalVectorStore.searchText', () => {
  it('is a LexicalVectorStore; the base PgVectorStore is not', () => {
    const client = { query: async () => [] };
    expect(isLexicalVectorStore(new PgLexicalVectorStore(client))).toBe(true);
    expect(isLexicalVectorStore(new PgVectorStore(client))).toBe(false);
  });

  it('runs explicit search syntax as written first, filter bindings after query + topK', async () => {
    const { client, calls } = fakeClient();
    const store = new PgLexicalVectorStore(client, { table: 't', fullText: { config: 'english' } });

    await store.searchText('"solar panels" -wind', { topK: 4, filter: { tenant: 't1' } });

    const sql = calls[0]?.sql ?? '';
    expect(sql).toContain(
      "to_tsvector('english'::regconfig, text) @@ websearch_to_tsquery('english', $1) AND metadata @> $3::jsonb",
    );
    expect(sql).toContain('ts_rank_cd(');
    expect(calls[0]?.params).toEqual(['"solar panels" -wind', 4, '{"tenant":"t1"}']);
    // Nothing matched as written: the meaningful terms, ranked.
    expect(calls).toHaveLength(2);
  });

  it('searches a question by its meaningful terms, ranked by IDF, without its stop words', async () => {
    const { client, calls } = fakeClient();
    const store = new PgLexicalVectorStore(client, { fullText: { column: 'tsv' } });

    await store.searchText("What's the solar-panel warranty?", {
      topK: 4,
      filter: { tenant: 't1' },
    });

    expect(calls).toHaveLength(1);
    const sql = calls[0]?.sql ?? '';
    expect(sql).toContain("tsv @@ to_tsquery('simple', $1) AND metadata @> $4::jsonb");
    expect(sql).toContain(
      'ln(1 + ((SELECT count(*) FROM __cand) - count(*) + 0.5) / (count(*) + 0.5))',
    );
    expect(calls[0]?.params).toEqual([
      "'solar' | 'panel' | 'warranty'",
      4,
      ['solar', 'panel', 'warranty'],
      '{"tenant":"t1"}',
    ]);
  });

  it("drops only the stop words of the question's language, or none when disabled", async () => {
    const { client, calls } = fakeClient();
    await new PgLexicalVectorStore(client).searchText('Qual é o prazo de reembolso?', { topK: 4 });
    expect(calls[0]?.params[2]).toEqual(['prazo', 'reembolso']);
    await new PgLexicalVectorStore(client, { fullText: { stopWords: false } }).searchText(
      'the warranty',
      { topK: 4 },
    );
    expect(calls[1]?.params[2]).toEqual(['the', 'warranty']);
  });

  it('only matches every word as written when the fallback is disabled', async () => {
    const { client, calls } = fakeClient();
    await new PgLexicalVectorStore(client, { fullText: { anyTermFallback: false } }).searchText(
      'two words',
      { topK: 4 },
    );
    expect(calls).toHaveLength(1);
    expect(calls[0]?.sql).toContain('websearch_to_tsquery');
  });

  it('answers a deny filter or a blank query without a round-trip', async () => {
    const { client, calls } = fakeClient();
    const store = new PgLexicalVectorStore(client);
    await expect(store.searchText('x', { topK: 4, filter: { tenant: [] } })).resolves.toEqual([]);
    await expect(store.searchText('   ', { topK: 4 })).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('refuses an unsafe configuration or column name', () => {
    const client = { query: async () => [] };
    expect(() => new PgLexicalVectorStore(client, { fullText: { config: "x'); DROP" } })).toThrow();
    expect(() => new PgLexicalVectorStore(client, { fullText: { column: 'a b' } })).toThrow();
  });
});

describe('PgVectorStore.whereConditions (subclass hook)', () => {
  it('routes every filtered statement through one overridable method', async () => {
    class TenantStore extends PgVectorStore {
      protected override whereConditions(
        filter: Record<string, unknown> | undefined,
        params: unknown[],
      ): string[] {
        params.push(filter?.tenantId);
        return [`tenant_id = $${params.length}`];
      }
    }
    const { client, calls } = fakeClient();
    const store = new TenantStore(client, { dimensions: 1 });

    await store.search([1], { topK: 3, filter: { tenantId: 't1' } });
    await store.countChunks({ tenantId: 't2' });

    expect(calls[0]?.sql).toContain('WHERE tenant_id = $3');
    expect(calls[0]?.params).toEqual(['[1]', 3, 't1']);
    expect(calls[1]?.sql).toContain('WHERE tenant_id = $1');
    expect(calls[1]?.params).toEqual(['t2']);
  });
});
