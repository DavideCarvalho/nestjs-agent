// Unit: ensureSchema's drift detection against the RESP2 wire shape. The testcontainers suite
// (redis-vector-store.db.spec.ts) drives a real RediSearch through node-redis, which decodes FT.INFO
// into RESP3 objects — so the flat key/value arrays an `ioredis`-backed client returns are only
// reachable with a fake. Same parser, the other half of its input space.
import { describe, expect, it, vi } from 'vitest';
import type { RedisSearchClient } from './redis-vector-store.js';
import { RedisVectorSchemaMismatchError, RedisVectorStore } from './redis-vector-store.js';

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
