// Integration: RedisVectorStore against a REAL RediSearch (Redis Stack via testcontainers). Proves
// FT.CREATE/HSET/FT.SEARCH KNN ranking + TAG metadata filtering — the parts a fake can't. Runs only
// under `pnpm test:db`.
import type { EmbeddingProvider } from '@dudousxd/nestjs-agent-core';
import { type RedisClientType, createClient } from 'redis';
import { GenericContainer, type StartedTestContainer, Wait } from 'testcontainers';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { EmbeddingRetriever } from './embedding-retriever.js';
import { HybridRetriever } from './hybrid-retriever.js';
import { LexicalRetriever } from './lexical-retriever.js';
import type { RedisSearchClient } from './redis-vector-store.js';
import { RedisVectorSchemaMismatchError, RedisVectorStore } from './redis-vector-store.js';
import { UnsafeRemovalError, isLexicalVectorStore } from './vector-store.js';

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

// updateMetadata's whole difficulty is that a chunk stores its metadata TWICE — as `meta_<field>`
// TAGs (what RediSearch filters on) and as the `metadata_json` blob (what comes back on a Passage).
// Only a real engine can prove the two move together: a fake can be told the filter matched.
describe('RedisVectorStore.updateMetadata (real RediSearch, dual representation)', () => {
  /** Its own index, so `bases` can be a second filterable field without disturbing the shared one. */
  let mutable: RedisVectorStore;

  /** Read a chunk's raw hash — the ONLY way to see the two representations separately. */
  async function hash(chunkId: string): Promise<Record<string, string>> {
    const reply = (await client.sendCommand(['HGETALL', `um:${chunkId}`])) as unknown;
    return (reply ?? {}) as Record<string, string>;
  }

  async function idsMatching(filter: Record<string, unknown>): Promise<string[]> {
    const passages = await mutable.search([1, 0, 0], { topK: 50, filter });
    return passages.map((passage) => passage.id).sort();
  }

  beforeAll(async () => {
    const search: RedisSearchClient = { sendCommand: (args) => client.sendCommand(args) };
    mutable = new RedisVectorStore(search, {
      dimensions: 3,
      index: 'um_idx',
      prefix: 'um:',
      filterableFields: ['tenant', 'bases'],
    });
    await mutable.ensureSchema();
  });

  it('RediSearch re-sees a TAG changed by a bare HSET — no reindex, and the vector survives', async () => {
    // The platform assumption the whole method rests on, pinned rather than assumed: writing the
    // hash field is enough for the index to pick the new value up on the very next query.
    await mutable.upsert([
      {
        id: 'raw#0',
        text: 'raw hset probe',
        embedding: [1, 0, 0],
        metadata: { tenant: 'raw-old' },
      },
    ]);
    expect(await idsMatching({ tenant: 'raw-old' })).toEqual(['raw#0']);

    await client.sendCommand(['HSET', 'um:raw#0', 'meta_tenant', 'raw-new']);

    expect(await idsMatching({ tenant: 'raw-new' })).toEqual(['raw#0']);
    expect(await idsMatching({ tenant: 'raw-old' })).toEqual([]);
    // ...and HDEL likewise drops it from the index
    await client.sendCommand(['HDEL', 'um:raw#0', 'meta_tenant']);
    expect(await idsMatching({ tenant: 'raw-new' })).toEqual([]);
  });

  it('moves BOTH representations: the index sees the new value, the Passage reports it, the old value is gone', async () => {
    await mutable.upsert([
      {
        id: 'doc#0',
        text: 'quarterly reimbursement policy',
        embedding: [1, 0, 0],
        source: 'docs/policy',
        metadata: { tenant: 'um-t1', bases: ['A', 'B'], title: 'quarterly' },
      },
      {
        id: 'doc#1',
        text: 'auditors submit receipts',
        embedding: [1, 0, 0],
        source: 'docs/policy',
        metadata: { tenant: 'um-t1', bases: ['A', 'B'], title: 'quarterly' },
      },
      // a different document sharing the `doc` prefix — must not be touched
      { id: 'docs#0', text: 'sibling', embedding: [1, 0, 0], metadata: { bases: ['A'] } },
    ]);
    expect(await idsMatching({ bases: ['A'] })).toEqual(['doc#0', 'doc#1', 'docs#0']);

    // the document is re-classified: it now covers B and C, and no longer A. No re-embedding.
    expect(await mutable.updateMetadata('doc', { bases: ['B', 'C'] })).toBe(2);

    // (1) the INDEX half — a filter on the new value finds it, on the old value does not
    expect(await idsMatching({ bases: ['C'] })).toEqual(['doc#0', 'doc#1']);
    expect(await idsMatching({ bases: ['B'] })).toEqual(['doc#0', 'doc#1']);
    expect(await idsMatching({ bases: ['A'] })).toEqual(['docs#0']); // only the untouched sibling

    // (2) the BLOB half — metadata read back off a retrieved Passage reflects the change...
    const passages = await mutable.search([1, 0, 0], { topK: 50, filter: { bases: ['C'] } });
    expect(passages).toHaveLength(2);
    for (const passage of passages) {
      expect(passage.metadata?.bases).toEqual(['B', 'C']);
      // ...and it is a MERGE: keys the patch never mentioned survive untouched
      expect(passage.metadata?.tenant).toBe('um-t1');
      expect(passage.metadata?.title).toBe('quarterly');
      // text and source are untouched — this is a metadata write, not a re-ingest
      expect(passage.source).toBe('docs/policy');
      expect(passage.text.length).toBeGreaterThan(0);
    }

    // (3) and directly at the wire, so neither half can be inferred from the other
    const raw = await hash('doc#0');
    expect(raw.meta_bases).toBe('B,C');
    expect(JSON.parse(raw.metadata_json ?? '{}')).toEqual({
      tenant: 'um-t1',
      bases: ['B', 'C'],
      title: 'quarterly',
    });
  });

  it('leaves text and embedding alone — the chunk is still KNN-ranked and still lexically findable', async () => {
    const knn = await mutable.search([1, 0, 0], { topK: 50, filter: { tenant: 'um-t1' } });
    expect(knn.map((passage) => passage.id)).toContain('doc#0');
    expect(knn[0]?.score).toBeGreaterThan(0);

    const lexical = await mutable.searchText('reimbursement quarterly', { topK: 10 });
    expect(lexical.map((passage) => passage.id)).toContain('doc#0');
  });

  it('a NON-filterable key lands in metadata_json only — no stray meta_* field is invented', async () => {
    expect(await mutable.updateMetadata('doc', { title: 'annual', reviewer: 'ada' })).toBe(2);

    const raw = await hash('doc#0');
    expect(Object.keys(raw).sort()).toEqual([
      'embedding',
      'meta_bases',
      'meta_tenant',
      'metadata_json',
      'source',
      'text',
    ]);
    expect(raw.meta_title).toBeUndefined();
    expect(raw.meta_reviewer).toBeUndefined();
    // the value is still there to be read back, it just isn't filterable
    expect(JSON.parse(raw.metadata_json ?? '{}')).toMatchObject({
      title: 'annual',
      reviewer: 'ada',
    });
    // and the filterable TAGs it did not mention are untouched
    expect(raw.meta_bases).toBe('B,C');
    expect(await idsMatching({ bases: ['C'] })).toEqual(['doc#0', 'doc#1']);
  });

  it('removes a key with an explicit null — TAG dropped from the index AND key gone from the blob', async () => {
    expect(await mutable.updateMetadata('doc', { bases: null, title: null })).toBe(2);

    const raw = await hash('doc#0');
    expect(raw.meta_bases).toBeUndefined(); // the TAG really was HDEL-ed, not left stale
    const metadata = JSON.parse(raw.metadata_json ?? '{}') as Record<string, unknown>;
    expect('bases' in metadata).toBe(false);
    expect('title' in metadata).toBe(false);
    expect(metadata.tenant).toBe('um-t1'); // untouched keys survive a removal patch

    expect(await idsMatching({ bases: ['B', 'C'] })).toEqual([]); // index agrees
    expect(await idsMatching({ tenant: 'um-t1' })).toEqual(['doc#0', 'doc#1']);
  });

  it('ignores an undefined value rather than treating it as a removal', async () => {
    // `{ tenant: undefined }` is what `{ ...doc, tenant: doc.tenant }` produces by accident, and what
    // any JSON hop would have dropped — deleting an ACL dimension on it would be the worst outcome.
    expect(await mutable.updateMetadata('doc', { tenant: undefined })).toBe(0);
    expect(await mutable.updateMetadata('doc', {})).toBe(0);
    expect(await idsMatching({ tenant: 'um-t1' })).toEqual(['doc#0', 'doc#1']);
    expect((await hash('doc#0')).meta_tenant).toBe('um-t1');
  });

  it('creates metadata on a chunk ingested without any, and patches a bare (unchunked) document id', async () => {
    await mutable.upsert([{ id: 'bare', text: 'no metadata at all', embedding: [1, 0, 0] }]);

    expect(await mutable.updateMetadata('bare', { tenant: 'um-bare' })).toBe(1);

    expect(await idsMatching({ tenant: 'um-bare' })).toEqual(['bare']);
    expect((await hash('bare')).meta_tenant).toBe('um-bare');
    expect(await mutable.listDocuments({ tenant: 'um-bare' })).toEqual([
      { id: 'bare', metadata: { tenant: 'um-bare' } },
    ]);
  });

  it('returns 0 for a document that is not indexed, instead of throwing', async () => {
    await expect(mutable.updateMetadata('never-ingested', { tenant: 'x' })).resolves.toBe(0);
  });
});

/**
 * Enumeration + bulk deletion against a real engine, on their own index so a destructive test can
 * never reach the corpus the other suites share. The properties under test are the ones a fake client
 * cannot establish: that the emitted queries are *valid* RediSearch, that a scoped delete really
 * leaves neighbouring scopes alone, and — the one that matters most — that the empty-array deny
 * deletes nothing rather than everything.
 */
describe('RedisVectorStore enumeration + bulk deletion (real RediSearch)', () => {
  let enumStore: RedisVectorStore;

  /** Rebuild a two-collection corpus from scratch, so each destructive case starts from a known set. */
  async function seed(): Promise<void> {
    for (const key of await client.keys('enum:*')) {
      await client.del(key);
    }
    await enumStore.upsert([
      { id: 'kb-a#0', text: 'kb a zero', embedding: [1, 0, 0], metadata: { collection: 'kb' } },
      { id: 'kb-a#1', text: 'kb a one', embedding: [1, 0, 0], metadata: { collection: 'kb' } },
      { id: 'kb-b#0', text: 'kb b zero', embedding: [1, 0, 0], metadata: { collection: 'kb' } },
      {
        id: 'ops-a#0',
        text: 'ops a zero',
        embedding: [0, 1, 0],
        metadata: { collection: 'ops' },
      },
      {
        id: 'ops-a#1',
        text: 'ops a one',
        embedding: [0, 1, 0],
        metadata: { collection: 'ops' },
      },
      // a document stored under a bare id (no `#n`), plus a multi-valued audience tag
      {
        id: 'bare',
        text: 'bare id document',
        embedding: [0, 0, 1],
        metadata: { collection: 'ops', audience: ['public', 'role:ADMIN'] },
      },
    ]);
  }

  beforeAll(async () => {
    const search: RedisSearchClient = { sendCommand: (args) => client.sendCommand(args) };
    enumStore = new RedisVectorStore(search, {
      dimensions: 3,
      index: 'enum_idx',
      prefix: 'enum:',
      filterableFields: ['collection', 'audience'],
    });
    await enumStore.ensureSchema();
  });

  beforeEach(seed);

  it('countChunks counts chunks without fetching them', async () => {
    expect(await enumStore.countChunks()).toBe(6);
    expect(await enumStore.countChunks({ collection: 'kb' })).toBe(3);
    expect(await enumStore.countChunks({ collection: 'ops' })).toBe(3);
    expect(await enumStore.countChunks({ audience: ['role:ADMIN'] })).toBe(1);
  });

  it('listDocumentIds returns the same ids as listDocuments, with no metadata round-trip', async () => {
    expect((await enumStore.listDocumentIds()).sort()).toEqual(['bare', 'kb-a', 'kb-b', 'ops-a']);
    expect((await enumStore.listDocumentIds({ collection: 'kb' })).sort()).toEqual([
      'kb-a',
      'kb-b',
    ]);
    // identical id set to the metadata-carrying enumeration it replaces
    const viaDocuments = (await enumStore.listDocuments()).map((document) => document.id).sort();
    expect((await enumStore.listDocumentIds()).sort()).toEqual(viaDocuments);
  });

  it('listChunks reads a document back in order, with prefix-stripped ids and metadata', async () => {
    const chunks = await enumStore.listChunks('kb-a');

    // Ids come back as the caller wrote them — the `enum:` key prefix is an implementation detail of
    // the store and must not leak into a chunk id the caller could hand back to `remove`.
    expect(chunks.map((chunk) => chunk.id)).toEqual(['kb-a#0', 'kb-a#1']);
    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1]);
    expect(chunks.map((chunk) => chunk.text)).toEqual(['kb a zero', 'kb a one']);
    expect(chunks[0]?.metadata).toEqual({ collection: 'kb' });
  });

  it('listChunks handles a bare-id document as chunk 0', async () => {
    // The bare key has no `#n` to parse, and it is found by EXISTS rather than by the SCAN pattern —
    // the same split `remove` relies on. Both halves have to end up in the result.
    expect(await enumStore.listChunks('bare')).toEqual([
      {
        id: 'bare',
        index: 0,
        text: 'bare id document',
        metadata: { collection: 'ops', audience: ['public', 'role:ADMIN'] },
      },
    ]);
  });

  it('listChunks orders numerically past ten, against a SCAN that returns no order at all', async () => {
    // The real reason this test exists: SCAN gives keys back in whatever order the keyspace yields,
    // so the ordering is entirely the store's own doing — and `#10` sorts before `#2` as a string.
    // Written in reverse so "whatever SCAN happened to return" cannot pass by luck.
    await enumStore.upsert(
      [11, 10, 9, 2, 1, 0].map((index) => ({
        id: `wide#${index}`,
        text: `wide ${index}`,
        embedding: [1, 0, 0],
        metadata: { collection: 'kb' },
      })),
    );

    expect((await enumStore.listChunks('wide')).map((chunk) => chunk.index)).toEqual([
      0, 1, 2, 9, 10, 11,
    ]);
    expect(
      (await enumStore.listChunks('wide', { limit: 2, offset: 3 })).map((c) => c.index),
    ).toEqual([9, 10]);
  });

  it('listChunks is scoped to the one document, and silent on an unknown one', async () => {
    expect(await enumStore.listChunks('nope')).toEqual([]);
    // `kb` is a strict prefix of `kb-a`/`kb-b`. The pattern is `<id>#*` plus an exact EXISTS, so a
    // prefix must match nothing — if this ever returned kb-a's chunks, `remove('kb')` would be
    // deleting them too.
    expect(await enumStore.listChunks('kb')).toEqual([]);
    expect((await enumStore.listChunks('ops-a')).map((chunk) => chunk.id)).toEqual([
      'ops-a#0',
      'ops-a#1',
    ]);
  });

  it('removeMany drops every chunk of every id — including a bare-id document — in one scan', async () => {
    await enumStore.removeMany(['kb-a', 'bare']);

    expect((await enumStore.listDocumentIds()).sort()).toEqual(['kb-b', 'ops-a']);
    expect(await enumStore.countChunks()).toBe(3);
    // and it did not reach into the *other* suites' prefixes
    expect(await store.countChunks({ tenant: 'ld-t1' })).toBeGreaterThan(0);
  });

  it('removeMany([]) is a no-op, not a wipe', async () => {
    await enumStore.removeMany([]);
    expect(await enumStore.countChunks()).toBe(6);
  });

  // ── the destructive properties ────────────────────────────────────────────────────────────────
  it('removeWhere scoped to one collection leaves the other collection intact', async () => {
    const removed = await enumStore.removeWhere({ collection: 'kb' });

    expect(removed).toBe(3);
    expect(await enumStore.countChunks({ collection: 'kb' })).toBe(0);
    expect(await enumStore.countChunks({ collection: 'ops' })).toBe(3);
    expect((await enumStore.listDocumentIds()).sort()).toEqual(['bare', 'ops-a']);
  });

  it('DELETES NOTHING for an empty-array filter — the deny primitive, against a real engine', async () => {
    // the corpus this would wipe if the guard were treated as "no filter"
    expect(await enumStore.countChunks()).toBe(6);

    expect(await enumStore.removeWhere({ audience: [] })).toBe(0);
    expect(await enumStore.removeWhere({ collection: [] })).toBe(0);
    // a deny ANDed with a scope that DOES match plenty still denies
    expect(await enumStore.removeWhere({ collection: 'kb', audience: [] })).toBe(0);

    expect(await enumStore.countChunks()).toBe(6);
    expect((await enumStore.listDocumentIds()).sort()).toEqual(['bare', 'kb-a', 'kb-b', 'ops-a']);
  });

  it('refuses an empty filter object instead of deleting the corpus', async () => {
    await expect(enumStore.removeWhere({})).rejects.toBeInstanceOf(UnsafeRemovalError);
    await expect(enumStore.removeWhere({})).rejects.toMatchObject({ reason: 'empty-filter' });
    expect(await enumStore.countChunks()).toBe(6);
  });

  it('refuses a filter key the index has no TAG for, rather than matching who-knows-what', async () => {
    await expect(enumStore.removeWhere({ tenant: 't1' })).rejects.toMatchObject({
      reason: 'unindexed-field',
    });
    expect(await enumStore.countChunks()).toBe(6);
  });

  it('an array filter value is OR here too, and removes only the union', async () => {
    expect(await enumStore.removeWhere({ audience: ['role:ADMIN', 'nobody'] })).toBe(1);
    expect((await enumStore.listDocumentIds()).sort()).toEqual(['kb-a', 'kb-b', 'ops-a']);
  });

  it('pages past a single DEL batch — a corpus larger than the batch is fully removed', async () => {
    const many = Array.from({ length: 600 }, (_, index) => ({
      id: `bulk-${index}#0`,
      text: `bulk chunk ${index}`,
      embedding: [1, 0, 0],
      metadata: { collection: 'bulk' },
    }));
    await enumStore.upsert(many);
    expect(await enumStore.countChunks({ collection: 'bulk' })).toBe(600);

    expect(await enumStore.removeWhere({ collection: 'bulk' })).toBe(600);
    expect(await enumStore.countChunks({ collection: 'bulk' })).toBe(0);
    expect(await enumStore.countChunks({ collection: 'kb' })).toBe(3);
  });

  it('deliberate mass deletion stays available, just spelled out', async () => {
    await enumStore.removeMany(await enumStore.listDocumentIds());
    expect(await enumStore.countChunks()).toBe(0);
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
