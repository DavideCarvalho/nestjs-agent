// Integration: RedisVectorStore against a REAL RediSearch (Redis Stack via testcontainers). Proves
// FT.CREATE/HSET/FT.SEARCH KNN ranking + TAG metadata filtering — the parts a fake can't. Runs only
// under `pnpm test:db`.
import type { EmbeddingProvider } from '@dudousxd/nestjs-agent-core';
import { type RedisClientType, createClient } from 'redis';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { EmbeddingRetriever } from './embedding-retriever.js';
import { HybridRetriever } from './hybrid-retriever.js';
import { LexicalRetriever } from './lexical-retriever.js';
import type { RedisSearchClient } from './redis-vector-store.js';
import { RedisVectorSchemaMismatchError, RedisVectorStore } from './redis-vector-store.js';
import { isLexicalVectorStore } from './vector-store.js';

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

  it('an array filter value is OR / set membership (incl. multi-valued tags); empty array denies', async () => {
    await store.upsert([
      { id: 'or-x', text: 'tenant or-t1', embedding: [0, 0, 1], metadata: { tenant: 'or-t1' } },
      { id: 'or-y', text: 'tenant or-t2', embedding: [0, 0, 1], metadata: { tenant: 'or-t2' } },
      // multi-valued tag: this document carries both or-t2 and or-t3
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
    expect(ids).toContain('or-z'); // matches or-t3 via its multi-valued tag
    expect(ids).not.toContain('or-y'); // only or-t2 — not requested

    const denied = await store.search([0, 0, 1], { topK: 50, filter: { tenant: [] } });
    expect(denied).toEqual([]);
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

  it('listDocuments collapses chunks to distinct documents with metadata, honoring filters', async () => {
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

    const t1 = await store.listDocuments({ tenant: 'ld-t1' });
    expect(t1.map((document) => document.id)).toEqual(['ld-a']);
    expect(t1[0]?.metadata?.tenant).toBe('ld-t1');

    const allIds = (await store.listDocuments()).map((document) => document.id).sort();
    expect(allIds).toContain('ld-a');
    expect(allIds).toContain('ld-b');
  });
});

// The store-backed lexical leg: BM25 straight out of the SAME RediSearch index the vectors live in.
// A fake client can prove the query string; only a real engine proves that the query is *valid*, that
// BM25 actually ranks, and — the property that matters most — that a hostile query cannot slip past
// the metadata filter that is carrying an ACL.
describe('RedisVectorStore.searchText (real RediSearch BM25)', () => {
  beforeAll(async () => {
    await store.upsert([
      {
        id: 'lex-a#0',
        text: 'quarterly reimbursement policy for travelling auditors',
        embedding: [1, 0, 0],
        source: 'docs/reimbursement',
        metadata: { tenant: 'lex-t1' },
      },
      {
        id: 'lex-a#1',
        text: 'auditors submit receipts within thirty days',
        embedding: [1, 0, 0],
        source: 'docs/reimbursement',
        metadata: { tenant: 'lex-t1' },
      },
      {
        id: 'lex-b#0',
        text: 'hydraulic actuator maintenance schedule',
        embedding: [0, 1, 0],
        source: 'docs/maintenance',
        metadata: { tenant: 'lex-t2' },
      },
      {
        id: 'lex-secret#0',
        text: 'reimbursement rules for tenant two auditors',
        embedding: [1, 0, 0],
        source: 'docs/other-tenant',
        metadata: { tenant: 'lex-t2' },
      },
    ]);
  });

  it('advertises the LexicalVectorStore capability', () => {
    expect(isLexicalVectorStore(store)).toBe(true);
  });

  it('ranks by keyword relevance over the index the vectors already live in', async () => {
    const passages = await store.searchText('reimbursement policy', { topK: 10 });
    const ids = passages.map((passage) => passage.id);

    expect(ids).toContain('lex-a#0');
    expect(ids).not.toContain('lex-b#0'); // shares no term with the query
    // the chunk carrying BOTH query terms outranks the one carrying only "reimbursement"
    expect(ids.indexOf('lex-a#0')).toBeLessThan(ids.indexOf('lex-secret#0'));
    expect(passages[0]?.score).toBeGreaterThan(0);
    // passages come back whole — text/source/metadata — as citations need
    const first = passages.find((passage) => passage.id === 'lex-a#0');
    expect(first?.text).toContain('reimbursement');
    expect(first?.source).toBe('docs/reimbursement');
    expect(first?.metadata?.tenant).toBe('lex-t1');
  });

  it('is findable the moment it is upserted — no index rebuild, no refresh window', async () => {
    await store.upsert([
      {
        id: 'lex-fresh#0',
        text: 'defenestration protocol for obsolete gantries',
        embedding: [0, 0, 1],
        metadata: { tenant: 'lex-t1' },
      },
    ]);
    const passages = await store.searchText('defenestration gantries', { topK: 5 });
    expect(passages.map((passage) => passage.id)).toContain('lex-fresh#0');
  });

  // ── the ACL properties ────────────────────────────────────────────────────────────────────────
  it('DENIES: an empty-array filter returns nothing, even for a query that matches plenty', async () => {
    const unfiltered = await store.searchText('reimbursement auditors', { topK: 10 });
    expect(unfiltered.length).toBeGreaterThan(0); // the query really does match

    const denied = await store.searchText('reimbursement auditors', {
      topK: 10,
      filter: { tenant: [] },
    });
    expect(denied).toEqual([]);
  });

  it('SCOPES: a scoped filter never returns another scope’s chunks', async () => {
    const scalar = await store.searchText('reimbursement auditors', {
      topK: 10,
      filter: { tenant: 'lex-t1' },
    });
    expect(scalar.length).toBeGreaterThan(0);
    expect(scalar.every((passage) => passage.metadata?.tenant === 'lex-t1')).toBe(true);
    expect(scalar.map((passage) => passage.id)).not.toContain('lex-secret#0');

    const arrayScoped = await store.searchText('reimbursement auditors', {
      topK: 10,
      filter: { tenant: ['lex-t1'] },
    });
    expect(arrayScoped.map((passage) => passage.id).sort()).toEqual(
      scalar.map((passage) => passage.id).sort(),
    );
  });

  it('a hostile query cannot escape the filter it is ANDed with', async () => {
    // every one of these tries to reach tenant lex-t2 (or the whole corpus) from inside a lex-t1 scope
    const attacks = [
      '*',
      'reimbursement) | (@meta_tenant:{lex\\-t2}',
      '@meta_tenant:{lex\\-t2}',
      'reimbursement -@meta_tenant:{lex\\-t1}',
      'reimbursement =>[KNN 10 @embedding $BLOB]',
      '~reimbursement | @tenant:{*}',
    ];
    for (const attack of attacks) {
      const passages = await store.searchText(attack, { topK: 20, filter: { tenant: 'lex-t1' } });
      expect(passages.every((passage) => passage.metadata?.tenant === 'lex-t1')).toBe(true);
      expect(passages.map((passage) => passage.id)).not.toContain('lex-secret#0');
      expect(passages.map((passage) => passage.id)).not.toContain('lex-b#0');
    }
  });

  it('an empty / punctuation-only query returns nothing rather than the whole corpus', async () => {
    expect(await store.searchText('', { topK: 10 })).toEqual([]);
    expect(await store.searchText('   ', { topK: 10 })).toEqual([]);
    expect(await store.searchText('*** ??? ...', { topK: 10 })).toEqual([]);
  });

  it('composes with EmbeddingRetriever inside HybridRetriever, filter intact', async () => {
    // a toy embedder: "reimbursement" queries point at the [1,0,0] axis the reimbursement chunks use
    const embedder: EmbeddingProvider = {
      embed: async (texts) => texts.map(() => [1, 0, 0]),
    };
    const hybrid = new HybridRetriever([
      new EmbeddingRetriever(embedder, store),
      new LexicalRetriever(store),
    ]);

    const passages = await hybrid.retrieve('reimbursement policy', {
      topK: 5,
      filter: { tenant: 'lex-t1' },
    });
    expect(passages.length).toBeGreaterThan(0);
    expect(passages.every((passage) => passage.metadata?.tenant === 'lex-t1')).toBe(true);
    expect(passages.map((passage) => passage.id)).toContain('lex-a#0');

    // and the deny primitive survives fusion
    expect(
      await hybrid.retrieve('reimbursement policy', { topK: 5, filter: { tenant: [] } }),
    ).toEqual([]);
  });
});

describe('ensureSchema against an index that already exists (drift)', () => {
  /** A fresh store on its own index, so each drift case starts from a known FT.CREATE. */
  function storeOn(
    name: string,
    options: { dimensions?: number; filterableFields?: string[] } = {},
    onCommand?: (args: (string | Buffer)[]) => void,
  ): RedisVectorStore {
    const search: RedisSearchClient = {
      sendCommand: (args) => {
        onCommand?.(args);
        return client.sendCommand(args);
      },
    };
    return new RedisVectorStore(search, {
      index: name,
      prefix: `${name}:`,
      dimensions: options.dimensions ?? 3,
      ...(options.filterableFields !== undefined
        ? { filterableFields: options.filterableFields }
        : {}),
    });
  }

  it('repairs a filterable field declared after the index was created, via FT.ALTER', async () => {
    await storeOn('drift_add_idx', { filterableFields: ['tenant'] }).ensureSchema();

    // a later deploy adds `audience` to filterableFields — the index predates it
    const widened = storeOn('drift_add_idx', { filterableFields: ['tenant', 'audience'] });
    await widened.ensureSchema();

    const info: unknown = await client.sendCommand(['FT.INFO', 'drift_add_idx']);
    const { attributes } = info as { attributes: { attribute: string; type: string }[] };
    expect(attributes.find((field) => field.attribute === 'meta_audience')?.type).toBe('TAG');

    // and the repaired TAG really is filterable, not just present in FT.INFO
    await widened.upsert([
      { id: 'w1', text: 'admin only', embedding: [1, 0, 0], metadata: { audience: 'role:ADMIN' } },
      { id: 'w2', text: 'everyone', embedding: [1, 0, 0], metadata: { audience: 'public' } },
    ]);
    const hits = await widened.search([1, 0, 0], { topK: 10, filter: { audience: 'role:ADMIN' } });
    expect(hits.map((passage) => passage.id)).toEqual(['w1']);
  });

  it('reports a dimension change loudly instead of leaving the index on the old width', async () => {
    await storeOn('drift_dim_idx', { dimensions: 3 }).ensureSchema();

    // the embedding model was swapped (3 → 5): not repairable in place
    const swapped = storeOn('drift_dim_idx', { dimensions: 5 });

    await expect(swapped.ensureSchema()).rejects.toBeInstanceOf(RedisVectorSchemaMismatchError);
    await expect(swapped.ensureSchema()).rejects.toMatchObject({
      index: 'drift_dim_idx',
      field: 'embedding',
      expected: 'DIM 5',
      actual: 'DIM 3',
    });
  });

  it('is a no-op when the live index already matches: no FT.CREATE, no FT.ALTER', async () => {
    await storeOn('drift_same_idx', { filterableFields: ['tenant'] }).ensureSchema();

    const commands: string[] = [];
    const again = storeOn('drift_same_idx', { filterableFields: ['tenant'] }, (args) =>
      commands.push(String(args[0])),
    );
    await again.ensureSchema();

    expect(commands).toEqual(['FT.INFO']);
  });

  it('still creates the index when it does not exist yet', async () => {
    const commands: string[] = [];
    const fresh = storeOn('drift_new_idx', { filterableFields: ['tenant'] }, (args) =>
      commands.push(String(args[0])),
    );
    await fresh.ensureSchema();

    expect(commands).toEqual(['FT.INFO', 'FT.CREATE']);
    await fresh.upsert([
      { id: 'n1', text: 'created', embedding: [0, 1, 0], metadata: { tenant: 'n' } },
    ]);
    expect(await fresh.search([0, 1, 0], { topK: 5, filter: { tenant: 'n' } })).toHaveLength(1);
  });
});
