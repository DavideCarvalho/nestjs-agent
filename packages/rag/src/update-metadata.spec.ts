// Unit: the merge semantics of `VectorStore.updateMetadata` — the pure patch helper every adapter
// shares, and `MemoryVectorStore`, the reference implementation of them. The Redis/pgvector adapters
// are proved against real engines in their `.db.spec.ts` files.
import { describe, expect, it, vi } from 'vitest';
import { MemoryVectorStore } from './memory-vector-store.js';
import { applyMetadataPatch, isEmptyMetadataPatch, splitMetadataPatch } from './metadata-patch.js';
import type { RedisSearchClient } from './redis-vector-store.js';
import { RedisVectorStore } from './redis-vector-store.js';

describe('applyMetadataPatch', () => {
  it('merges: keys the patch never mentions keep their stored value', () => {
    expect(applyMetadataPatch({ tenant: 't1', bases: ['A'] }, { bases: ['B'] })).toEqual({
      tenant: 't1',
      bases: ['B'],
    });
  });

  it('replaces an array wholesale — it does not append to or union with the stored one', () => {
    expect(applyMetadataPatch({ bases: ['A', 'B', 'C'] }, { bases: ['B'] })).toEqual({
      bases: ['B'],
    });
    expect(applyMetadataPatch({ bases: ['A'] }, { bases: [] })).toEqual({ bases: [] });
  });

  it('replaces a nested object wholesale too — the merge is shallow, not RFC 7386 recursive', () => {
    expect(
      applyMetadataPatch({ acl: { read: ['a'], write: ['b'] } }, { acl: { read: ['c'] } }),
    ).toEqual({ acl: { read: ['c'] } });
  });

  it('removes a key on an explicit null, and only on null', () => {
    expect(applyMetadataPatch({ tenant: 't1', bases: ['A'] }, { bases: null })).toEqual({
      tenant: 't1',
    });
    // undefined is ignored: it does not survive JSON, and it is what a spread produces by accident
    expect(applyMetadataPatch({ tenant: 't1' }, { tenant: undefined })).toEqual({ tenant: 't1' });
  });

  it('creates the object when the record had no metadata at all', () => {
    expect(applyMetadataPatch(undefined, { tenant: 't1' })).toEqual({ tenant: 't1' });
    expect(applyMetadataPatch(undefined, { tenant: null })).toEqual({});
  });

  it('never mutates its input', () => {
    const stored = { tenant: 't1', bases: ['A'] };
    const patched = applyMetadataPatch(stored, { bases: ['B'], tenant: null });
    expect(stored).toEqual({ tenant: 't1', bases: ['A'] });
    expect(patched).not.toBe(stored);
  });
});

describe('splitMetadataPatch / isEmptyMetadataPatch', () => {
  it('separates assignments from null removals and drops undefined entirely', () => {
    expect(splitMetadataPatch({ a: 1, b: null, c: undefined })).toEqual({
      set: { a: 1 },
      remove: ['b'],
    });
  });

  it('an empty or all-undefined patch writes nothing', () => {
    expect(isEmptyMetadataPatch({})).toBe(true);
    expect(isEmptyMetadataPatch({ a: undefined })).toBe(true);
    expect(isEmptyMetadataPatch({ a: null })).toBe(false);
  });
});

describe('MemoryVectorStore.updateMetadata', () => {
  async function seeded(): Promise<MemoryVectorStore> {
    const store = new MemoryVectorStore();
    await store.upsert([
      {
        id: 'doc#0',
        text: 'chunk zero',
        embedding: [1, 0, 0],
        metadata: { tenant: 't1', bases: ['A', 'B'] },
      },
      {
        id: 'doc#1',
        text: 'chunk one',
        embedding: [1, 0, 0],
        metadata: { tenant: 't1', bases: ['A', 'B'] },
      },
      { id: 'other#0', text: 'untouched', embedding: [1, 0, 0], metadata: { bases: ['A'] } },
    ]);
    return store;
  }

  it('patches every chunk of the document, returns the count, and leaves siblings alone', async () => {
    const store = await seeded();
    expect(await store.updateMetadata('doc', { bases: ['B', 'C'] })).toBe(2);

    const found = await store.search([1, 0, 0], { topK: 10, filter: { bases: ['C'] } });
    expect(found.map((passage) => passage.id).sort()).toEqual(['doc#0', 'doc#1']);
    expect(found.every((passage) => passage.metadata?.tenant === 't1')).toBe(true);

    // the old value no longer matches the patched document, but does still match the sibling
    const old = await store.search([1, 0, 0], { topK: 10, filter: { bases: ['A'] } });
    expect(old.map((passage) => passage.id)).toEqual(['other#0']);
  });

  it('leaves text and embedding untouched — nothing is re-embedded', async () => {
    const store = await seeded();
    await store.updateMetadata('doc', { bases: ['C'] });
    const [first] = await store.search([1, 0, 0], { topK: 1, filter: { bases: ['C'] } });
    expect(first?.text).toBe('chunk zero');
    expect(first?.score).toBeCloseTo(1);
  });

  it('does not mutate the metadata object the caller upserted', async () => {
    const store = new MemoryVectorStore();
    const metadata = { tenant: 't1' };
    await store.upsert([{ id: 'd#0', text: 'x', embedding: [1, 0, 0], metadata }]);
    await store.updateMetadata('d', { tenant: 't2' });
    expect(metadata).toEqual({ tenant: 't1' });
  });

  it('returns 0 for an unknown document and for a patch that writes nothing', async () => {
    const store = await seeded();
    expect(await store.updateMetadata('never-ingested', { tenant: 't9' })).toBe(0);
    expect(await store.updateMetadata('doc', {})).toBe(0);
    expect(await store.updateMetadata('doc', { tenant: undefined })).toBe(0);
    expect((await store.listDocuments({ tenant: 't1' })).map((d) => d.id).sort()).toEqual(['doc']);
  });

  it('removes a key with null, so a filter on the removed value stops matching', async () => {
    const store = await seeded();
    expect(await store.updateMetadata('doc', { bases: null })).toBe(2);
    expect(await store.search([1, 0, 0], { topK: 10, filter: { bases: ['A', 'B'] } })).toHaveLength(
      1,
    );
    const [document] = await store.listDocuments({ tenant: 't1' });
    expect(document?.metadata).toEqual({ tenant: 't1' });
  });
});

// Wire-level: which Redis commands updateMetadata emits. The db spec proves the *effect* against a
// real engine; this pins the shape — above all that a non-filterable key never invents a `meta_*`
// field, which is invisible from the outside precisely because the index does not know about it.
describe('RedisVectorStore.updateMetadata (emitted commands)', () => {
  function fakeClient(stored: Record<string, unknown>) {
    const commands: (string | Buffer)[][] = [];
    const client: RedisSearchClient = {
      sendCommand: vi.fn(async (args: (string | Buffer)[]) => {
        commands.push(args);
        switch (String(args[0])) {
          case 'EXISTS':
            return 1;
          case 'SCAN':
            return ['0', []];
          case 'HGET':
            return JSON.stringify(stored);
          default:
            return 'OK';
        }
      }),
    };
    return { client, commands };
  }

  function store(client: RedisSearchClient): RedisVectorStore {
    return new RedisVectorStore(client, {
      prefix: 'rag:',
      dimensions: 3,
      filterableFields: ['tenant', 'bases'],
    });
  }

  it('writes metadata_json and the filterable TAGs in ONE HSET, never the embedding', async () => {
    const { client, commands } = fakeClient({ tenant: 't1', bases: ['A'], title: 'q' });
    expect(await store(client).updateMetadata('doc', { bases: ['B', 'C'] })).toBe(1);

    const hset = commands.find((args) => String(args[0]) === 'HSET');
    expect(hset?.map(String)).toEqual([
      'HSET',
      'rag:doc',
      'metadata_json',
      '{"tenant":"t1","bases":["B","C"],"title":"q"}',
      'meta_tenant',
      't1',
      'meta_bases',
      'B,C', // multi-valued TAG, encoded exactly as upsert encodes it
    ]);
    expect(commands.map((args) => String(args[0]))).not.toContain('HDEL');
  });

  it('invents no meta_* field for a key that is not filterable', async () => {
    const { client, commands } = fakeClient({ tenant: 't1' });
    await store(client).updateMetadata('doc', { title: 'annual', reviewer: 'ada' });

    const hset = (commands.find((args) => String(args[0]) === 'HSET') ?? []).map(String);
    expect(hset).not.toContain('meta_title');
    expect(hset).not.toContain('meta_reviewer');
    expect(hset).toContain('meta_tenant'); // the filterable one is still rewritten in step
    expect(hset[3]).toBe('{"tenant":"t1","title":"annual","reviewer":"ada"}');
  });

  it('HDELs a removed filterable TAG BEFORE the write, so the window fails closed', async () => {
    const { client, commands } = fakeClient({ tenant: 't1', bases: ['A'] });
    await store(client).updateMetadata('doc', { bases: null });

    const verbs = commands.map((args) => String(args[0]));
    expect(verbs.indexOf('HDEL')).toBeLessThan(verbs.indexOf('HSET'));
    expect(commands[verbs.indexOf('HDEL')]?.map(String)).toEqual(['HDEL', 'rag:doc', 'meta_bases']);
    expect((commands[verbs.indexOf('HSET')] ?? []).map(String)).not.toContain('meta_bases');
  });

  it('does not HDEL a filterable field the chunk never carried', async () => {
    const { client, commands } = fakeClient({ tenant: 't1' });
    await store(client).updateMetadata('doc', { title: 'x' });
    expect(commands.map((args) => String(args[0]))).not.toContain('HDEL');
  });

  it('sends nothing at all for a patch that writes nothing', async () => {
    const { client, commands } = fakeClient({ tenant: 't1' });
    expect(await store(client).updateMetadata('doc', { tenant: undefined })).toBe(0);
    expect(commands).toEqual([]);
  });
});
