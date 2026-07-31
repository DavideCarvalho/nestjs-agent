import { describe, expect, it } from 'vitest';
import { HybridRetriever } from './hybrid-retriever.js';
import { LexicalRetriever } from './lexical-retriever.js';
import { MemoryVectorStore } from './memory-vector-store.js';
import { type RedisSearchClient, RedisVectorStore } from './redis-vector-store.js';
import { type LexicalVectorStore, isLexicalVectorStore } from './vector-store.js';

/** Captures the raw command args so we can assert on the exact FT.SEARCH query string emitted. */
function fakeClient(reply: unknown = [0]): {
  client: RedisSearchClient;
  calls: (string | Buffer)[][];
} {
  const calls: (string | Buffer)[][] = [];
  return {
    calls,
    client: {
      sendCommand: async (args) => {
        calls.push(args);
        return reply;
      },
    },
  };
}

function newStore(reply?: unknown) {
  const { client, calls } = fakeClient(reply);
  const store = new RedisVectorStore(client, {
    dimensions: 3,
    index: 'idx',
    prefix: 'p:',
    filterableFields: ['tenant', 'audience'],
  });
  return { store, calls };
}

/** The query string is always FT.SEARCH's third argument. */
function queryOf(call: (string | Buffer)[]): string {
  return String(call[2]);
}

describe('isLexicalVectorStore', () => {
  it('detects the capability without the caller knowing the adapter', () => {
    const { client } = fakeClient();
    expect(isLexicalVectorStore(new RedisVectorStore(client))).toBe(true);
    expect(isLexicalVectorStore(new MemoryVectorStore())).toBe(false);
  });
});

describe('RedisVectorStore.searchText query building', () => {
  it('ORs the query terms, scoped to the text field, scored by BM25', async () => {
    const { store, calls } = newStore();
    await store.searchText('refund policy', { topK: 7 });

    expect(calls).toHaveLength(1);
    const call = calls[0] ?? [];
    expect(queryOf(call)).toBe('@text:(refund|policy)');
    const args = call.map(String);
    expect(args.slice(0, 2)).toEqual(['FT.SEARCH', 'idx']);
    expect(args).toContain('WITHSCORES');
    expect(args[args.indexOf('SCORER') + 1]).toBe('BM25');
    expect(args.slice(-3)).toEqual(['LIMIT', '0', '7']);
  });

  it('honours a custom scorer', async () => {
    const { client, calls } = fakeClient();
    const store = new RedisVectorStore(client, { lexicalScorer: 'BM25STD' });
    await store.searchText('hello', { topK: 1 });
    const args = (calls[0] ?? []).map(String);
    expect(args[args.indexOf('SCORER') + 1]).toBe('BM25STD');
  });

  it('ANDs the metadata filter onto the text clause', async () => {
    const { store, calls } = newStore();
    await store.searchText('refund', { topK: 5, filter: { tenant: 't1' } });
    expect(queryOf(calls[0] ?? [])).toBe('((@meta_tenant:{t1}) @text:(refund))');
  });

  it('keeps the array filter as an OR alternation, exactly like search()', async () => {
    const { store, calls } = newStore();
    await store.searchText('refund', {
      topK: 5,
      filter: { audience: ['public', 'role:ADMIN'] },
    });
    // the ACL tokens are escaped as TAG values (`role\:ADMIN`), the query term is not part of them
    expect(queryOf(calls[0] ?? [])).toBe('((@meta_audience:{public|role\\:ADMIN}) @text:(refund))');
  });

  it('keeps unicode terms — a non-English corpus stays searchable', async () => {
    const { store, calls } = newStore();
    await store.searchText('política de reembolso 退款', { topK: 5 });
    expect(queryOf(calls[0] ?? [])).toBe('@text:(política|de|reembolso|退款)');
  });
});

describe('RedisVectorStore.searchText — adversarial queries', () => {
  const attacks: [name: string, query: string, expected: string][] = [
    ['a bare wildcard cannot become match-all', '*', ''],
    ['a field selector cannot be injected', '@meta_tenant:{other}', '@text:(meta_tenant|other)'],
    [
      'the text clause cannot be closed and a new clause opened',
      'refund) | (@meta_tenant:{other}',
      '@text:(refund|meta_tenant|other)',
    ],
    ['negation cannot be injected', '-refund', '@text:(refund)'],
    ['a prefix wildcard cannot be injected', 'refu*', '@text:(refu)'],
    ['fuzzy / optional operators are stripped', '%refund% ~policy', '@text:(refund|policy)'],
    ['a quoted phrase cannot unbalance the query', '"refund', '@text:(refund)'],
    [
      'a vector clause cannot be appended',
      'a =>[KNN 10 @embedding $B]',
      '@text:(a|KNN|10|embedding|B)',
    ],
    ['an escape character cannot leak through', 'refund\\', '@text:(refund)'],
  ];

  for (const [name, query, expected] of attacks) {
    it(name, async () => {
      const { store, calls } = newStore();
      const passages = await store.searchText(query, { topK: 5, filter: { tenant: 't1' } });

      if (expected === '') {
        // nothing searchable survived → no command at all, and certainly no match-all
        expect(calls).toHaveLength(0);
        expect(passages).toEqual([]);
        return;
      }
      const emitted = queryOf(calls[0] ?? []);
      expect(emitted).toBe(`((@meta_tenant:{t1}) ${expected})`);
      // the filter clause is intact and the text clause contains no RediSearch metacharacters
      expect(emitted.startsWith('((@meta_tenant:{t1}) @text:(')).toBe(true);
      const terms = emitted.slice(emitted.indexOf('@text:(') + 7, -2);
      expect(terms).toMatch(/^[\p{L}\p{N}_|]*$/u);
    });
  }
});

describe('RedisVectorStore.searchText — empty results by construction', () => {
  it('returns [] for an empty or whitespace-only query without touching Redis', async () => {
    for (const query of ['', '   ', '\n\t']) {
      const { store, calls } = newStore();
      expect(await store.searchText(query, { topK: 5 })).toEqual([]);
      expect(calls).toHaveLength(0);
    }
  });

  it('returns [] for a punctuation-only query rather than matching the corpus', async () => {
    const { store, calls } = newStore();
    expect(await store.searchText('*** ??? ...', { topK: 5 })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('DENIES on an empty-array filter — the ACL primitive — without querying', async () => {
    const { store, calls } = newStore();
    expect(await store.searchText('refund', { topK: 5, filter: { audience: [] } })).toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it('denies even when another filter key would have matched', async () => {
    const { store, calls } = newStore();
    expect(
      await store.searchText('refund', { topK: 5, filter: { tenant: 't1', audience: [] } }),
    ).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('RedisVectorStore.searchText — reply parsing', () => {
  it('reads the inline BM25 score from the RESP2 WITHSCORES shape', async () => {
    const { store } = newStore([
      2,
      'p:a#0',
      '3.5',
      ['text', 'about refunds', 'source', 'docs/refunds', 'metadata_json', '{"tenant":"t1"}'],
      'p:b#0',
      '1.25',
      ['text', 'about rockets'],
    ]);
    const passages = await store.searchText('refund', { topK: 5 });
    expect(passages).toEqual([
      {
        id: 'a#0',
        text: 'about refunds',
        score: 3.5,
        source: 'docs/refunds',
        metadata: { tenant: 't1' },
      },
      { id: 'b#0', text: 'about rockets', score: 1.25 },
    ]);
  });

  it('reads the score from the RESP3 object shape', async () => {
    const { store } = newStore({
      total_results: 1,
      results: [{ id: 'p:a#0', score: 2.75, extra_attributes: { text: 'about refunds' } }],
    });
    const passages = await store.searchText('refund', { topK: 5 });
    expect(passages).toEqual([{ id: 'a#0', text: 'about refunds', score: 2.75 }]);
  });

  it('leaves the KNN reply shape untouched (2 elements per result, cosine score)', async () => {
    const { store } = newStore([1, 'p:a#0', ['text', 'about refunds', 'vector_score', '0.25']]);
    const passages = await store.search([1, 0, 0], { topK: 5 });
    expect(passages).toEqual([{ id: 'a#0', text: 'about refunds', score: 0.75 }]);
  });
});

describe('LexicalRetriever', () => {
  function recordingStore(passages: { id: string; text: string; score: number }[] = []) {
    const seen: { query: string; options: unknown }[] = [];
    const store: LexicalVectorStore = {
      upsert: async () => undefined,
      search: async () => [],
      remove: async () => undefined,
      updateMetadata: async () => 0,
      listDocuments: async () => [],
      listChunks: async () => [],
      listDocumentIds: async () => [],
      removeMany: async () => undefined,
      removeWhere: async () => 0,
      countChunks: async () => 0,
      searchText: async (query, options) => {
        seen.push({ query, options });
        return passages;
      },
    };
    return { store, seen };
  }

  it('passes the query straight through and defaults topK to 5', async () => {
    const { store, seen } = recordingStore();
    await new LexicalRetriever(store).retrieve('refund policy');
    expect(seen).toEqual([{ query: 'refund policy', options: { topK: 5 } }]);
  });

  it('forwards topK and filter — the filter is the ACL, so it must not be dropped', async () => {
    const { store, seen } = recordingStore();
    await new LexicalRetriever(store).retrieve('refund', {
      topK: 3,
      filter: { audience: ['public'] },
    });
    expect(seen).toEqual([
      { query: 'refund', options: { topK: 3, filter: { audience: ['public'] } } },
    ]);
  });

  it('composes into HybridRetriever with no other change', async () => {
    const { store } = recordingStore([
      { id: 'a#0', text: 'lexical hit', score: 9.1 },
      { id: 'b#0', text: 'other', score: 2 },
    ]);
    const dense = {
      retrieve: async () => [
        { id: 'b#0', text: 'other', score: 0.9 },
        { id: 'c#0', text: 'dense only', score: 0.5 },
      ],
    };
    const hybrid = new HybridRetriever([dense, new LexicalRetriever(store)]);
    const fused = await hybrid.retrieve('refund', { topK: 3 });
    // b#0 appears in both lists, so RRF ranks it first despite the incompatible score scales
    expect(fused[0]?.id).toBe('b#0');
    expect(fused.map((passage) => passage.id).sort()).toEqual(['a#0', 'b#0', 'c#0']);
  });
});
