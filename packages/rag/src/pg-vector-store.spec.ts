// Unit: PgVectorStore must never hand Postgres a NUL byte (0x00) — `text`/`jsonb` columns reject it
// outright ("invalid byte sequence for encoding "UTF8": 0x00"), and text extracted from PDFs
// sometimes carries one even though Qdrant tolerates it. A fake PgClient captures the exact
// bindings sent to `query`, so these assert on the wire values without a real Postgres — the db
// suite (pg-vector-store.db.spec.ts) proves everything that needs a live engine.
import { describe, expect, it, vi } from 'vitest';
import type { PgClient } from './pg-vector-store.js';
import { PgVectorStore } from './pg-vector-store.js';

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
});
