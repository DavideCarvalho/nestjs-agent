// Unit: ensureSchema's drift detection against the RESP2 wire shape. The testcontainers suite
// (redis-vector-store.db.spec.ts) drives a real RediSearch through node-redis, which decodes FT.INFO
// into RESP3 objects — so the flat key/value arrays an `ioredis`-backed client returns are only
// reachable with a fake. Same parser, the other half of its input space.
import { describe, expect, it, vi } from 'vitest';
import type { RedisSearchClient } from './redis-vector-store.js';
import { RedisVectorSchemaMismatchError, RedisVectorStore } from './redis-vector-store.js';
import { UnsafeRemovalError } from './vector-store.js';

/** FT.INFO as RESP2: a flat key/value array whose attributes are themselves flat key/value arrays. */
function resp2Info(options: { dim: number; tags: string[] }): unknown[] {
  const attributes: unknown[] = [
    ['identifier', 'text', 'attribute', 'text', 'type', 'TEXT', 'WEIGHT', '1'],
    ['identifier', 'source', 'attribute', 'source', 'type', 'TAG', 'SEPARATOR', ','],
    ...options.tags.map((tag) => [
      'identifier',
      tag,
      'attribute',
      tag,
      'type',
      'TAG',
      'SEPARATOR',
      ',',
    ]),
    [
      'identifier',
      'embedding',
      'attribute',
      'embedding',
      'type',
      'VECTOR',
      'algorithm',
      'HNSW',
      'data_type',
      'FLOAT32',
      'dim',
      String(options.dim),
      'distance_metric',
      'COSINE',
    ],
  ];
  return ['index_name', 'idx', 'index_options', [], 'attributes', attributes, 'num_docs', '0'];
}

/** A client that answers FT.INFO with `info` (or throws it) and records every command. */
function fakeClient(info: unknown | Error) {
  const commands: (string | Buffer)[][] = [];
  const client: RedisSearchClient = {
    sendCommand: vi.fn(async (args: (string | Buffer)[]) => {
      commands.push(args);
      if (String(args[0]) === 'FT.INFO') {
        if (info instanceof Error) {
          throw info;
        }
        return info;
      }
      return 'OK';
    }),
  };
  return { client, commands };
}

describe('RedisVectorStore.ensureSchema (RESP2 replies)', () => {
  it('creates the index when FT.INFO reports it missing', async () => {
    const { client, commands } = fakeClient(new Error('Unknown index name'));
    await new RedisVectorStore(client, {
      dimensions: 4,
      filterableFields: ['tenant'],
    }).ensureSchema();

    expect(commands.map((args) => String(args[0]))).toEqual(['FT.INFO', 'FT.CREATE']);
    expect(commands[1]).toContain('meta_tenant');
    expect(commands[1]).toContain('4');
  });

  it('adds a filterable TAG the live index is missing', async () => {
    const { client, commands } = fakeClient(resp2Info({ dim: 3, tags: ['meta_tenant'] }));
    await new RedisVectorStore(client, {
      index: 'agent_rag_idx',
      dimensions: 3,
      filterableFields: ['tenant', 'audience'],
    }).ensureSchema();

    expect(commands).toHaveLength(2);
    expect(commands[1]).toEqual([
      'FT.ALTER',
      'agent_rag_idx',
      'SCHEMA',
      'ADD',
      'meta_audience',
      'TAG',
    ]);
  });

  it('throws a typed mismatch on a dimension change, naming both widths', async () => {
    const { client, commands } = fakeClient(resp2Info({ dim: 1024, tags: [] }));
    const store = new RedisVectorStore(client, { index: 'agent_rag_idx', dimensions: 1536 });

    await expect(store.ensureSchema()).rejects.toBeInstanceOf(RedisVectorSchemaMismatchError);
    await expect(store.ensureSchema()).rejects.toThrow(/DIM 1024.*expected DIM 1536/s);
    // it must not have tried to "repair" anything on the way out
    expect(commands.every((args) => String(args[0]) === 'FT.INFO')).toBe(true);
  });

  it('throws when a declared filterable key exists with an incompatible type', async () => {
    // the field is there, so no ALTER would fire — but it is TEXT, and a TAG filter on it can never
    // match. Exactly the silent-wrong-results case ensureSchema exists to prevent.
    const { client } = fakeClient([
      'attributes',
      [['identifier', 'meta_tenant', 'attribute', 'meta_tenant', 'type', 'TEXT', 'WEIGHT', '1']],
    ]);
    const store = new RedisVectorStore(client, { dimensions: 3, filterableFields: ['tenant'] });

    await expect(store.ensureSchema()).rejects.toBeInstanceOf(RedisVectorSchemaMismatchError);
    await expect(store.ensureSchema()).rejects.toMatchObject({
      field: 'meta_tenant',
      expected: 'TAG',
      actual: 'TEXT',
    });
  });

  it('infers no drift from an FT.INFO reply it cannot parse', async () => {
    const { client, commands } = fakeClient({ some: 'unexpected shape' });
    await new RedisVectorStore(client, {
      dimensions: 99,
      filterableFields: ['tenant'],
    }).ensureSchema();

    // no false alarm, and no blind ALTER against an index we know nothing about
    expect(commands.map((args) => String(args[0]))).toEqual(['FT.INFO']);
  });
});

/**
 * A scripted client, so a test can assert on the exact commands the store emits — including the ones
 * it must NOT emit. The db suite proves the behaviour against a real engine; this proves that the
 * refusals happen *before* anything reaches the wire, which is the only place you can see that a
 * denied removal never even asked Redis to delete.
 */
function scriptedClient(replies: Record<string, unknown> | ((verb: string) => unknown)) {
  const commands: (string | Buffer)[][] = [];
  const client: RedisSearchClient = {
    sendCommand: vi.fn(async (args: (string | Buffer)[]) => {
      commands.push(args);
      const verb = String(args[0]);
      return typeof replies === 'function' ? replies(verb) : (replies[verb] ?? 'OK');
    }),
  };
  return { client, commands, verbs: () => commands.map((args) => String(args[0])) };
}

describe('RedisVectorStore.removeWhere (guards, before anything hits the wire)', () => {
  function store(client: RedisSearchClient): RedisVectorStore {
    return new RedisVectorStore(client, {
      index: 'idx',
      prefix: 'p:',
      dimensions: 3,
      filterableFields: ['tenant', 'audience'],
    });
  }

  it('an empty-array filter value sends NO command at all and removes 0', async () => {
    const { client, verbs } = scriptedClient({});
    expect(await store(client).removeWhere({ audience: [] })).toBe(0);
    // the point: not "it deleted nothing because the query matched nothing" — it never asked.
    expect(verbs()).toEqual([]);
  });

  it('a deny ANDed with a real scope still denies', async () => {
    const { client, verbs } = scriptedClient({});
    expect(await store(client).removeWhere({ tenant: 't1', audience: [] })).toBe(0);
    expect(verbs()).toEqual([]);
  });

  it('an empty filter object throws rather than emitting the `*` query', async () => {
    const { client, verbs } = scriptedClient({});
    await expect(store(client).removeWhere({})).rejects.toBeInstanceOf(UnsafeRemovalError);
    expect(verbs()).toEqual([]);
  });

  it('a key that is not a declared filterable field throws, naming it', async () => {
    const { client, verbs } = scriptedClient({});
    await expect(store(client).removeWhere({ collection: 'kb' })).rejects.toMatchObject({
      reason: 'unindexed-field',
    });
    await expect(store(client).removeWhere({ collection: 'kb' })).rejects.toThrow(/"collection"/);
    expect(verbs()).toEqual([]);
  });

  it('a scoped filter issues a NOCONTENT search and DELs exactly its keys', async () => {
    // one page of two keys, then an empty page to end the loop
    let searches = 0;
    const { client, commands, verbs } = scriptedClient((verb) => {
      if (verb !== 'FT.SEARCH') {
        return 2;
      }
      searches += 1;
      return searches === 1 ? [2, 'p:doc#0', 'p:doc#1'] : [0];
    });

    expect(await store(client).removeWhere({ tenant: 't1' })).toBe(2);
    expect(verbs()).toEqual(['FT.SEARCH', 'DEL', 'FT.SEARCH']);
    expect(commands[0]).toContain('NOCONTENT');
    expect(commands[0]).toContain('(@meta_tenant:{t1})');
    expect(commands[1]).toEqual(['DEL', 'p:doc#0', 'p:doc#1']);
  });

  it('stops instead of spinning when DEL reports nothing removed', async () => {
    const { client, verbs } = scriptedClient({ 'FT.SEARCH': [1, 'p:ghost#0'], DEL: 0 });
    expect(await store(client).removeWhere({ tenant: 't1' })).toBe(0);
    expect(verbs()).toEqual(['FT.SEARCH', 'DEL']);
  });
});

describe('RedisVectorStore enumeration (RESP2 replies)', () => {
  it('countChunks reads the total out of a LIMIT 0 0 search', async () => {
    const { client, commands } = scriptedClient({ 'FT.SEARCH': [42] });
    const store = new RedisVectorStore(client, { index: 'idx', prefix: 'p:', dimensions: 3 });

    expect(await store.countChunks()).toBe(42);
    expect(commands[0]?.slice(-6)).toEqual(['NOCONTENT', 'LIMIT', '0', '0', 'DIALECT', '2']);
    expect(commands[0]).toContain('*');
  });

  it('countChunks denies on an empty-array filter without querying', async () => {
    const { client, verbs } = scriptedClient({ 'FT.SEARCH': [42] });
    const store = new RedisVectorStore(client, {
      index: 'idx',
      prefix: 'p:',
      dimensions: 3,
      filterableFields: ['tenant'],
    });
    expect(await store.countChunks({ tenant: [] })).toBe(0);
    expect(verbs()).toEqual([]);
  });

  it('listDocumentIds collapses NOCONTENT keys to distinct document ids', async () => {
    const { client, commands } = scriptedClient({
      'FT.SEARCH': [3, 'p:doc-a#0', 'p:doc-a#1', 'p:doc-b#0'],
    });
    const store = new RedisVectorStore(client, { index: 'idx', prefix: 'p:', dimensions: 3 });

    expect((await store.listDocumentIds()).sort()).toEqual(['doc-a', 'doc-b']);
    expect(commands[0]).toContain('NOCONTENT');
    // no metadata_json asked for, so nothing to JSON.parse
    expect(commands[0]).not.toContain('metadata_json');
  });
});
