import { createNoopEmitUi } from '@dudousxd/nestjs-agent-core';
import { describe, expect, it, vi } from 'vitest';
import { MemoryVectorStore } from './memory-vector-store.js';
import { RagIndex, RagScopeRequiredError, anyOf, ragFilterableFields } from './rag-index.js';
import type { VectorStore } from './vector-store.js';

interface Doc {
  id: number;
  projectId: string;
  body?: string | null;
  owner?: string | null;
}

const scope = { projectId: (d: Doc) => d.projectId };
const definition = { name: 'doc', id: (d: Doc) => d.id, text: (d: Doc) => d.body, scope };
const embedder = () => ({ embed: vi.fn(async (t: string[]) => t.map(() => [1, 0])) });

async function setup() {
  const store = new MemoryVectorStore();
  const emb = embedder();
  const rag = new RagIndex(definition, { store, embedder: emb });
  await rag.index({ id: 1, projectId: 'a', body: 'one' });
  await rag.index({ id: 2, projectId: 'b', body: 'two' });
  emb.embed.mockClear();
  return { store, emb, rag };
}
const ids = (passages: { id: string }[]) => passages.map((p) => p.id).sort();

describe('RagIndex scope', () => {
  it('isolates, and a filter cannot override the scope', async () => {
    const { rag } = await setup();
    expect(ids(await rag.search('q', { scope: { projectId: 'a' } }))).toEqual(['doc:1#0']);
    const forced = await rag.search('q', {
      scope: { projectId: 'a' },
      filter: { projectId: 'b', ragEntity: 'other' } as never,
    });
    expect(ids(forced)).toEqual(['doc:1#0']);
  });

  it.each([
    [{ projectId: undefined }],
    [{}],
    [{ projectId: '' }],
    [{ projectId: null }],
    [{ projectId: ['a', 'b'] }],
    [{ projectId: Number.NaN }],
    [undefined],
  ])('refuses scope %j before the paid embed', async (bad) => {
    const { rag, emb } = await setup();
    await expect(rag.search('q', { scope: bad as never })).rejects.toBeInstanceOf(
      RagScopeRequiredError,
    );
    expect(emb.embed).not.toHaveBeenCalled();
  });

  it('anyOf refuses a missing element', async () => {
    const { rag, emb } = await setup();
    await expect(
      rag.search('q', { scope: { projectId: anyOf([undefined as never]) } }),
    ).rejects.toBeInstanceOf(RagScopeRequiredError);
    expect(emb.embed).not.toHaveBeenCalled();
  });

  it('a row with no id cannot be indexed', async () => {
    const { rag, emb, store } = await setup();
    const before = await store.countChunks();
    await expect(rag.index({ projectId: 'a', body: 'x' } as unknown as Doc)).rejects.toThrow(
      /needs an id/,
    );
    expect(emb.embed).not.toHaveBeenCalled();
    expect(await store.countChunks()).toBe(before);
  });

  it('anyOf widens explicitly, and an empty one denies', async () => {
    const { rag } = await setup();
    expect(ids(await rag.search('q', { scope: { projectId: anyOf(['a', 'b']) } }))).toEqual([
      'doc:1#0',
      'doc:2#0',
    ]);
    expect(await rag.search('q', { scope: { projectId: anyOf([]) } })).toEqual([]);
  });

  it('a number and its string are the same scope', async () => {
    const store = new MemoryVectorStore();
    const rag = new RagIndex(
      { name: 'n', id: (d: Doc) => d.id, text: (d: Doc) => d.body, scope: { n: (d: Doc) => d.id } },
      { store, embedder: embedder() },
    );
    await rag.index({ id: 7, projectId: 'x', body: 'seven' });
    expect(await rag.search('q', { scope: { n: 7 } })).toHaveLength(1);
    expect(await rag.search('q', { scope: { n: anyOf([7]) } })).toHaveLength(1);
  });

  it('two models sharing a store do not mix, even with the same id and scope', async () => {
    const store = new MemoryVectorStore();
    const a = new RagIndex(definition, { store, embedder: embedder() });
    const b = new RagIndex({ ...definition, name: 'other' }, { store, embedder: embedder() });
    await a.index({ id: 1, projectId: 'p', body: 'a' });
    await b.index({ id: 1, projectId: 'p', body: 'b' });
    expect(ids(await a.search('q', { scope: { projectId: 'p' } }))).toEqual(['doc:1#0']);
    await a.remove(1);
    expect(ids(await b.search('q', { scope: { projectId: 'p' } }))).toEqual(['other:1#0']);
  });

  it('metadata cannot override the scope', async () => {
    const store = new MemoryVectorStore();
    const rag = new RagIndex(
      { ...definition, metadata: () => ({ projectId: 'evil', lang: 'pt' }) },
      { store, embedder: embedder() },
    );
    await rag.index({ id: 1, projectId: 'a', body: 'x' });
    const [hit] = await rag.search('q', { scope: { projectId: 'a' }, filter: { lang: 'pt' } });
    expect(hit?.metadata).toMatchObject({ projectId: 'a', lang: 'pt' });
  });

  it('a row with no scope value cannot be indexed', async () => {
    const { rag, emb } = await setup();
    const row = { id: 3, projectId: undefined, body: 'x' } as unknown as Doc;
    await expect(rag.index(row)).rejects.toBeInstanceOf(RagScopeRequiredError);
    expect(emb.embed).not.toHaveBeenCalled();
  });

  it('a global corpus says scope: {}', async () => {
    const store = new MemoryVectorStore();
    const rag = new RagIndex({ ...definition, scope: {} }, { store, embedder: embedder() });
    await rag.index({ id: 1, projectId: 'a', body: 'x' });
    expect(await rag.search('q', {})).toHaveLength(1);
  });
});

describe('RagIndex.index', () => {
  it('keeps the previous chunks when the embedder fails', async () => {
    const { store } = await setup();
    const broken = new RagIndex(definition, {
      store,
      embedder: { embed: async () => Promise.reject(new Error('quota')) },
    });
    await expect(broken.index({ id: 1, projectId: 'a', body: 'new' })).rejects.toThrow('quota');
    expect((await store.listChunks('doc:1'))[0]?.text).toBe('one');
  });

  it('embeds, then replaces', async () => {
    const calls: string[] = [];
    const store = new MemoryVectorStore();
    const spied = new Proxy(store, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        if (key === 'replaceDocument' && typeof value === 'function') {
          return (...args: unknown[]) => {
            calls.push(key);
            return value.apply(target, args);
          };
        }
        return value;
      },
    }) as VectorStore;
    const rag = new RagIndex(definition, {
      store: spied,
      embedder: {
        embed: async (t) => {
          calls.push('embed');
          return t.map(() => [1, 0]);
        },
      },
    });
    await rag.index({ id: 1, projectId: 'a', body: 'x' });
    expect(calls).toEqual(['embed', 'replaceDocument']);
  });

  it('a shorter version leaves no tail, and blank text removes', async () => {
    const store = new MemoryVectorStore();
    const rag = new RagIndex(
      { ...definition, chunk: { chunkSize: 20, overlap: 0 } },
      { store, embedder: embedder() },
    );
    expect(await rag.index({ id: 1, projectId: 'a', body: 'word '.repeat(40) })).toBeGreaterThan(1);
    expect(await rag.index({ id: 1, projectId: 'a', body: 'short' })).toBe(1);
    expect(await store.listChunks('doc:1')).toHaveLength(1);
    expect(await rag.index({ id: 1, projectId: 'a', body: '  ' })).toBe(0);
    expect(await store.listChunks('doc:1')).toEqual([]);
  });

  it('maxChunks caps what one document can cost', async () => {
    const emb = embedder();
    const rag = new RagIndex(
      { ...definition, chunk: { chunkSize: 20, overlap: 0 }, maxChunks: 2 },
      { store: new MemoryVectorStore(), embedder: emb },
    );
    expect(await rag.index({ id: 1, projectId: 'a', body: 'word '.repeat(40) })).toBe(2);
    expect(emb.embed.mock.calls[0]?.[0]).toHaveLength(2);
  });
});

describe('RagIndex.reconcile', () => {
  it('removes orphans and reports what is missing', async () => {
    const { rag, store } = await setup();
    const result = await rag.reconcile([1, 3]);
    expect(result).toEqual({ orphans: ['doc:2'], missing: ['doc:3'] });
    expect(await store.listChunks('doc:2')).toEqual([]);
  });

  it('dryRun removes nothing; a scope limits the comparison', async () => {
    const { rag, store } = await setup();
    expect((await rag.reconcile([], { dryRun: true })).orphans).toHaveLength(2);
    expect(await store.countChunks()).toBe(2);
    expect((await rag.reconcile([], { scope: { projectId: 'a' } })).orphans).toEqual(['doc:1']);
    expect(await store.listChunks('doc:2')).toHaveLength(1);
  });

  it.each([undefined, '', Number.NaN])('refuses a scope of %s', async (projectId) => {
    const { rag, store } = await setup();
    await expect(rag.reconcile([], { scope: { projectId } as never })).rejects.toBeInstanceOf(
      RagScopeRequiredError,
    );
    expect(await store.countChunks()).toBe(2);
  });

  it('does not touch another model', async () => {
    const { store } = await setup();
    const other = new RagIndex({ ...definition, name: 'other' }, { store, embedder: embedder() });
    expect((await other.reconcile([])).orphans).toEqual([]);
    expect(await store.countChunks()).toBe(2);
  });
});

describe('RagIndex usage and tool', () => {
  it('reports usage for indexing and searching', async () => {
    const onUsage = vi.fn();
    const rag = new RagIndex(definition, {
      store: new MemoryVectorStore(),
      embedder: {
        embed: async () => [],
        embedWithUsage: async (t: string[]) => ({
          vectors: t.map(() => [1, 0]),
          usage: { inputTokens: t.length, modelId: 'm' },
        }),
      } as never,
      onUsage,
    });
    await rag.index({ id: 1, projectId: 'a', body: 'x' });
    await rag.search('q', { scope: { projectId: 'a' } });
    expect(onUsage).toHaveBeenCalledTimes(2);
    expect(onUsage).toHaveBeenCalledWith({ inputTokens: 1, modelId: 'm' });
  });

  it('the tool takes its scope from the context, not from the input', async () => {
    const { rag } = await setup();
    const tool = rag.tool({
      name: 'search_docs',
      scope: (ctx) => ({ projectId: ctx.actor.tenantRef as string }),
    });
    const ctx = { actor: { tenantRef: 'a' }, emitUi: createNoopEmitUi() } as never;
    const out = (await tool.handler.execute(
      { query: 'q', projectId: 'b', filter: { projectId: 'b' } },
      ctx,
    )) as { passages: { id: string }[] };
    expect(ids(out.passages)).toEqual(['doc:1#0']);
  });

  it('a tool whose context has no scope refuses to search', async () => {
    const { rag, emb } = await setup();
    const tool = rag.tool({
      name: 'search_docs',
      scope: (ctx) => ({ projectId: ctx.actor.tenantRef as string }),
    });
    await expect(
      tool.handler.execute({ query: 'q' }, { actor: {} } as never),
    ).rejects.toBeInstanceOf(RagScopeRequiredError);
    expect(emb.embed).not.toHaveBeenCalled();
  });

  it('ragFilterableFields declares the entity key and the scope', () => {
    expect(ragFilterableFields('projectId')).toEqual(['ragEntity', 'projectId']);
  });
});

// Compile-time contract, checked by `typecheck:specs`.
function typeContract(rag: RagIndex<Doc, typeof scope>) {
  void rag.search('q', { scope: { projectId: 'p' } });
  void rag.search('q', { scope: { projectId: anyOf(['p']) }, filter: { lang: 'pt' } });
  // @ts-expect-error options are required
  void rag.search('q');
  // @ts-expect-error scope is required
  void rag.search('q', {});
  // @ts-expect-error wrong key
  void rag.search('q', { scope: { tenantId: 'p' } });
  // @ts-expect-error undefined
  void rag.search('q', { scope: { projectId: undefined } });
  // @ts-expect-error a bare array cannot widen
  void rag.search('q', { scope: { projectId: ['a', 'b'] } });
  // @ts-expect-error a filter cannot name a scope key
  void rag.search('q', { scope: { projectId: 'p' }, filter: { projectId: 'x' } });
  // @ts-expect-error a definition must declare its scope
  new RagIndex({ name: 'x', id: (d: Doc) => d.id, text: (d: Doc) => d.body }, {} as never);
  new RagIndex(
    {
      name: 'x',
      id: (d: Doc) => d.id,
      text: (d: Doc) => d.body,
      // @ts-expect-error a nullable column cannot be a scope
      scope: { owner: (d: Doc) => d.owner },
    },
    {} as never,
  );
}
void typeContract;
