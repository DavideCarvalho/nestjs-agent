import { FakeEmbeddingProvider } from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import { chunkText } from './chunk.js';
import { EmbeddingRetriever } from './embedding-retriever.js';
import { FilteredRetriever } from './filtered-retriever.js';
import { chunkDocuments, ingestChunks, ingestDocuments } from './ingest.js';
import { MemoryVectorStore } from './memory-vector-store.js';
import { createRetrievalTool } from './retrieval-tool.js';
import { UnsafeRemovalError } from './vector-store.js';

describe('chunkText', () => {
  it('returns the whole text as one chunk when under the size limit', () => {
    expect(chunkText('short text', { chunkSize: 100 })).toEqual(['short text']);
  });

  it('returns nothing for blank input', () => {
    expect(chunkText('   ')).toEqual([]);
  });

  it('splits long text into overlapping chunks that each stay near the size limit', () => {
    const text = Array.from({ length: 50 }, (_, index) => `sentence number ${index}.`).join(' ');
    const chunks = chunkText(text, { chunkSize: 120, overlap: 30 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(120);
    }
    // reassembled coverage: every sentence marker survives somewhere
    expect(chunks.join(' ')).toContain('sentence number 49.');
  });
});

describe('chunkText default path is unchanged by the separator option', () => {
  // Pinned against the pre-separator implementation, mid-word cuts and all. Adding `separator` is
  // only a minor if a caller who does not pass one gets exactly the bytes they got before, so these
  // two expectations are copied from the old implementation's output rather than reasoned about.
  // The cuts they pin ("Epsilon zeta" / "ilon zeta") are also the behaviour record mode exists to
  // avoid: the chunker breaks at a character offset, not at anything the text means.
  it('cuts prose where it always did', () => {
    expect(
      chunkText(
        'Alpha beta gamma delta. Epsilon zeta eta theta. Iota kappa lambda mu. Nu xi omicron pi rho sigma.',
        { chunkSize: 40, overlap: 10 },
      ),
    ).toEqual([
      'Alpha beta gamma delta. Epsilon zeta',
      'ilon zeta eta theta. Iota kappa lambda',
      'pa lambda mu. Nu xi omicron pi rho',
      'on pi rho sigma.',
    ]);
  });

  it('cuts paragraphed text where it always did', () => {
    expect(
      chunkText(
        'First paragraph here.\n\nSecond paragraph here.\n\nThird paragraph is longer than the rest of them.',
        { chunkSize: 45, overlap: 12 },
      ),
    ).toEqual([
      'First paragraph here.\n\nSecond paragraph',
      'd paragraph here.\n\nThird paragraph is longer',
      'h is longer than the rest of them.',
    ]);
  });
});

describe('chunkText with a record separator', () => {
  const record = (row: number): string =>
    `MVR row ${row} | Vehicle: 4A218${row} | Odometer: ${41000 + row} | Fuel Type: DIESEL | Remarks: none`;
  const records = Array.from({ length: 40 }, (_, index) => record(index));
  const document = records.join('\n');
  const options = { chunkSize: 200, separator: '\n' };

  it('files every record whole, in exactly one chunk', () => {
    const chunks = chunkText(document, options);
    expect(chunks.length).toBeGreaterThan(1);
    for (const one of records) {
      expect(chunks.filter((chunk) => chunk.includes(one))).toHaveLength(1);
    }
  });

  it('packs greedily, so a chunk holds more than one record but never exceeds chunkSize', () => {
    const chunks = chunkText(document, options);
    expect(chunks.length).toBeLessThan(records.length);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(200);
    }
  });

  it('preserves order and loses nothing: the chunks reassemble into the input records', () => {
    expect(chunkText(document, options).join('\n').split('\n')).toEqual(records);
  });

  it('ignores overlap — the same chunks come out whatever it is set to', () => {
    const carried = chunkText(document, { ...options, overlap: 150 });
    expect(carried).toEqual(chunkText(document, { ...options, overlap: 0 }));
    // the point of ignoring it: no record is duplicated into its neighbour
    for (const one of records) {
      expect(carried.filter((chunk) => chunk.includes(one))).toHaveLength(1);
    }
  });

  it('splits a record longer than chunkSize, and leaves its neighbours whole', () => {
    const oversized = Array.from({ length: 40 }, (_, index) => `word${index}`).join(' ');
    const chunks = chunkText([record(1), oversized, record(2)].join('\n'), {
      chunkSize: 100,
      separator: '\n',
    });
    expect(chunks.filter((chunk) => chunk.includes(record(1)))).toHaveLength(1);
    expect(chunks.filter((chunk) => chunk.includes(record(2)))).toHaveLength(1);
    expect(chunks.some((chunk) => chunk.includes(oversized))).toBe(false);
    // the fallback is confined to that one record, and splits it rather than dropping any of it
    const pieces = chunks.slice(1, -1);
    expect(pieces.length).toBeGreaterThan(1);
    expect(pieces.join(' ')).toBe(oversized);
  });

  it('returns nothing for blank input', () => {
    expect(chunkText('   ', options)).toEqual([]);
  });

  it('treats text the separator never appears in as a single record', () => {
    expect(chunkText('one line, no separator in it', options)).toEqual([
      'one line, no separator in it',
    ]);
  });

  it('splits that single record blind when it does not fit', () => {
    const long = Array.from({ length: 40 }, (_, index) => `word${index}`).join(' ');
    const chunks = chunkText(long, { chunkSize: 100, separator: '\n' });
    expect(chunks.length).toBeGreaterThan(1);
    expect(chunks.join(' ')).toBe(long);
  });

  it('drops leading, trailing and repeated separators instead of emitting empty records', () => {
    expect(chunkText('\n\n\nalpha\n\n\nbeta\n\n\n', options)).toEqual(['alpha\nbeta']);
  });

  it('drops records that are only whitespace, and trims the rest', () => {
    expect(chunkText('  alpha  \n   \t  \n  beta  ', options)).toEqual(['alpha\nbeta']);
  });

  it('falls back to the default path for an empty separator', () => {
    const text = 'Alpha beta gamma delta. Epsilon zeta eta theta. Iota kappa lambda mu.';
    expect(chunkText(text, { chunkSize: 40, overlap: 10, separator: '' })).toEqual(
      chunkText(text, { chunkSize: 40, overlap: 10 }),
    );
  });

  it('carries through ingestion, so a collection can be chunked by record end to end', async () => {
    const embedder = new FakeEmbeddingProvider();
    const store = new MemoryVectorStore();
    const written = await ingestDocuments([{ id: 'mvr', text: document }], {
      embedder,
      store,
      ...options,
    });
    expect(written).toBe(chunkText(document, options).length);
  });
});

describe('ingest + retrieve (MemoryVectorStore + EmbeddingRetriever)', () => {
  async function buildRetriever() {
    const embedder = new FakeEmbeddingProvider();
    const store = new MemoryVectorStore();
    const written = await ingestDocuments(
      [
        {
          id: 'doc-cats',
          text: 'Cats are small domestic felines that purr and chase mice.',
          source: 'animals/cats',
        },
        {
          id: 'doc-rockets',
          text: 'Rockets burn propellant to reach orbit and escape gravity.',
          source: 'space/rockets',
        },
      ],
      { embedder, store, chunkSize: 200 },
    );
    return { retriever: new EmbeddingRetriever(embedder, store), written };
  }

  it('ranks the topically-matching passage first', async () => {
    const { retriever, written } = await buildRetriever();
    expect(written).toBe(2);
    const passages = await retriever.retrieve('domestic feline that chases mice', { topK: 2 });
    expect(passages[0]?.source).toBe('animals/cats');
  });

  it('honours topK', async () => {
    const { retriever } = await buildRetriever();
    expect(await retriever.retrieve('anything', { topK: 1 })).toHaveLength(1);
  });

  it('re-ingesting a document overwrites its chunks (deterministic ids), no duplicates', async () => {
    const embedder = new FakeEmbeddingProvider();
    const store = new MemoryVectorStore();
    await ingestDocuments([{ id: 'd', text: 'first version' }], { embedder, store });
    await ingestDocuments([{ id: 'd', text: 'second version' }], { embedder, store });
    const passages = await retriever(embedder, store);
    expect(passages).toHaveLength(1);
    expect(passages[0]?.text).toBe('second version');
  });

  async function retriever(
    embedder: FakeEmbeddingProvider,
    store: MemoryVectorStore,
  ): ReturnType<EmbeddingRetriever['retrieve']> {
    return new EmbeddingRetriever(embedder, store).retrieve('version', { topK: 10 });
  }
});

describe('MemoryVectorStore.remove', () => {
  it('drops every chunk of a document and nothing else', async () => {
    const embedder = new FakeEmbeddingProvider();
    const store = new MemoryVectorStore();
    // small chunkSize so each doc becomes several chunks (ids `${id}#0`, `${id}#1`, …)
    await ingestDocuments(
      [
        { id: 'keep', text: 'alpha beta gamma delta epsilon zeta eta theta' },
        { id: 'drop', text: 'one two three four five six seven eight nine ten' },
      ],
      { embedder, store, chunkSize: 20, overlap: 0 },
    );

    await store.remove('drop');

    const passages = await new EmbeddingRetriever(embedder, store).retrieve('anything', {
      topK: 100,
    });
    expect(passages.length).toBeGreaterThan(0);
    expect(passages.every((passage) => passage.id.startsWith('keep#'))).toBe(true);
  });

  it('leaves no orphan when a re-ingested document shrinks to fewer chunks', async () => {
    const embedder = new FakeEmbeddingProvider();
    const store = new MemoryVectorStore();
    await ingestChunks(
      chunkDocuments([{ id: 'd', text: 'aaa bbb ccc ddd eee fff' }], { chunkSize: 12, overlap: 0 }),
      { embedder, store },
    );
    // re-ingest a much shorter version — remove first, then upsert
    await store.remove('d');
    await ingestChunks(chunkDocuments([{ id: 'd', text: 'tiny' }]), { embedder, store });

    const passages = await new EmbeddingRetriever(embedder, store).retrieve('anything', {
      topK: 100,
    });
    expect(passages).toHaveLength(1);
    expect(passages[0]?.text).toBe('tiny');
  });
});

describe('MemoryVectorStore.listDocuments', () => {
  it('returns distinct documents (chunks collapsed) with metadata, filtered by metadata', async () => {
    const embedder = new FakeEmbeddingProvider();
    const store = new MemoryVectorStore();
    await ingestDocuments(
      [
        { id: 'alice-1', text: 'a b c d e f g h', metadata: { owner: 'alice' } },
        { id: 'alice-2', text: 'more of alice content here', metadata: { owner: 'alice' } },
        { id: 'bob-1', text: 'bob content', metadata: { owner: 'bob' } },
      ],
      { embedder, store, chunkSize: 12, overlap: 0 },
    );

    const alice = await store.listDocuments({ owner: 'alice' });
    expect(alice.map((document) => document.id).sort()).toEqual(['alice-1', 'alice-2']);
    expect(alice.every((document) => document.metadata?.owner === 'alice')).toBe(true);
    expect(await store.listDocuments()).toHaveLength(3);
  });
});

describe('MemoryVectorStore enumeration + bulk deletion', () => {
  async function corpus(): Promise<MemoryVectorStore> {
    const embedder = new FakeEmbeddingProvider();
    const store = new MemoryVectorStore();
    await ingestDocuments(
      [
        {
          id: 'kb-a',
          text: 'a b c d e f g h',
          metadata: { collection: 'kb', audience: ['public'] },
        },
        { id: 'kb-b', text: 'more knowledge base content', metadata: { collection: 'kb' } },
        {
          id: 'other-a',
          text: 'a different collection entirely',
          metadata: { collection: 'other' },
        },
      ],
      { embedder, store, chunkSize: 12, overlap: 0 },
    );
    return store;
  }

  it('listDocumentIds returns the ids listDocuments would, without the metadata', async () => {
    const store = await corpus();
    expect((await store.listDocumentIds()).sort()).toEqual(['kb-a', 'kb-b', 'other-a']);
    expect((await store.listDocumentIds({ collection: 'kb' })).sort()).toEqual(['kb-a', 'kb-b']);
    expect(await store.listDocumentIds({ audience: [] })).toEqual([]);
  });

  it('countChunks counts chunks, not documents', async () => {
    const store = await corpus();
    const all = await store.countChunks();
    const kb = await store.countChunks({ collection: 'kb' });
    expect(all).toBeGreaterThan(3); // kb-a alone chunks into several
    expect(kb).toBeLessThan(all);
    expect(kb + (await store.countChunks({ collection: 'other' }))).toBe(all);
    expect(await store.countChunks({ collection: [] })).toBe(0);
  });

  it('removeMany drops every chunk of every listed document in one pass', async () => {
    const store = await corpus();
    await store.removeMany(['kb-a', 'other-a']);
    expect((await store.listDocumentIds()).sort()).toEqual(['kb-b']);
    await store.removeMany([]); // no-op, not a wipe
    expect(await store.listDocumentIds()).toEqual(['kb-b']);
  });

  it('removeWhere deletes only the matching scope and reports the chunk count', async () => {
    const store = await corpus();
    const kbChunks = await store.countChunks({ collection: 'kb' });
    const otherChunks = await store.countChunks({ collection: 'other' });

    const removed = await store.removeWhere({ collection: 'kb' });

    expect(removed).toBe(kbChunks);
    expect(await store.countChunks({ collection: 'kb' })).toBe(0);
    expect(await store.countChunks({ collection: 'other' })).toBe(otherChunks);
    expect(await store.listDocumentIds()).toEqual(['other-a']);
  });

  it('removeWhere with an empty-array filter deletes NOTHING (the deny primitive)', async () => {
    const store = await corpus();
    const before = await store.countChunks();

    expect(await store.removeWhere({ audience: [] })).toBe(0);
    expect(await store.removeWhere({ collection: 'kb', audience: [] })).toBe(0);

    expect(await store.countChunks()).toBe(before);
    expect((await store.listDocumentIds()).sort()).toEqual(['kb-a', 'kb-b', 'other-a']);
  });

  it('removeWhere refuses an empty filter object instead of wiping the store', async () => {
    const store = await corpus();
    const before = await store.countChunks();

    await expect(store.removeWhere({})).rejects.toBeInstanceOf(UnsafeRemovalError);
    await expect(store.removeWhere({})).rejects.toMatchObject({ reason: 'empty-filter' });

    expect(await store.countChunks()).toBe(before);
  });

  it('deliberate mass deletion stays possible, just explicit', async () => {
    const store = await corpus();
    await store.removeMany(await store.listDocumentIds());
    expect(await store.countChunks()).toBe(0);
  });

  it('listChunks reads a document back in order, with its text and metadata', async () => {
    const store = await corpus();
    const chunks = await store.listChunks('kb-a');

    expect(chunks.length).toBe(2);
    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1]);
    expect(chunks.map((chunk) => chunk.id)).toEqual(['kb-a#0', 'kb-a#1']);
    // The text is the indexed string verbatim — reassembling the chunks (this corpus overlaps by 0)
    // gives back the document, which is the property the whole method exists to let a caller check.
    expect(chunks.map((chunk) => chunk.text).join(' ')).toBe('a b c d e f g h');
    expect(chunks[0]?.metadata).toEqual({ collection: 'kb', audience: ['public'] });
  });

  it('listChunks pages with limit/offset over the ordered chunks', async () => {
    const store = new MemoryVectorStore();
    await store.upsert(
      [0, 1, 2, 3].map((index) => ({
        id: `doc#${index}`,
        text: `chunk ${index}`,
        embedding: [index],
      })),
    );
    const all = await store.listChunks('doc');
    expect(all.length).toBe(4);

    expect(await store.listChunks('doc', { limit: 2 })).toEqual(all.slice(0, 2));
    expect(await store.listChunks('doc', { offset: 1 })).toEqual(all.slice(1));
    expect(await store.listChunks('doc', { limit: 2, offset: 1 })).toEqual(all.slice(1, 3));
    // Past the end is empty, not an error — a caller paging until short is a normal way to use this.
    expect(await store.listChunks('doc', { offset: 99 })).toEqual([]);
  });

  it('listChunks orders numerically, not lexically', async () => {
    const store = new MemoryVectorStore();
    // Inserted out of order and past ten on purpose: a Map preserves insertion order and `#10` sorts
    // before `#2` as text, so both the "trust the Map" and the "sort as strings" bugs fail here.
    await store.upsert(
      [11, 2, 0].map((index) => ({
        id: `doc#${index}`,
        text: `chunk ${index}`,
        embedding: [index],
      })),
    );

    expect((await store.listChunks('doc')).map((chunk) => chunk.index)).toEqual([0, 2, 11]);
  });

  it('listChunks is scoped to one document and silent on an unknown one', async () => {
    const store = await corpus();
    expect(await store.listChunks('kb-b')).not.toEqual(await store.listChunks('kb-a'));
    // The id prefix of another document must not leak in: `kb-a` is a prefix of nothing here, but
    // `documentIdOf` equality (not startsWith) is what guarantees that in general.
    expect(await store.listChunks('kb')).toEqual([]);
    expect(await store.listChunks('nope')).toEqual([]);
  });
});

describe('FilteredRetriever', () => {
  async function ownerScopedStore() {
    const embedder = new FakeEmbeddingProvider();
    const store = new MemoryVectorStore();
    await ingestDocuments(
      [
        { id: 'a-doc', text: 'shared topic sentence', metadata: { owner: 'alice' } },
        { id: 'b-doc', text: 'shared topic sentence', metadata: { owner: 'bob' } },
      ],
      { embedder, store },
    );
    return { base: new EmbeddingRetriever(embedder, store) };
  }

  it('only returns passages matching the fixed owner filter', async () => {
    const { base } = await ownerScopedStore();
    const scoped = new FilteredRetriever(base, { owner: 'alice' });
    const passages = await scoped.retrieve('shared topic', { topK: 10 });
    expect(passages.length).toBeGreaterThan(0);
    expect(passages.every((passage) => passage.metadata?.owner === 'alice')).toBe(true);
  });

  it('a caller cannot widen past the fixed scope', async () => {
    const { base } = await ownerScopedStore();
    const scoped = new FilteredRetriever(base, { owner: 'alice' });
    // caller tries to override the owner — fixed filter wins
    const passages = await scoped.retrieve('shared topic', { topK: 10, filter: { owner: 'bob' } });
    expect(passages.every((passage) => passage.metadata?.owner === 'alice')).toBe(true);
  });
});

describe('createRetrievalTool', () => {
  it('exposes a read tool whose handler returns retrieved passages', async () => {
    const embedder = new FakeEmbeddingProvider();
    const store = new MemoryVectorStore();
    await ingestDocuments([{ id: 'd', text: 'the quick brown fox', source: 'fox' }], {
      embedder,
      store,
    });
    const tool = createRetrievalTool(new EmbeddingRetriever(embedder, store));

    expect(tool.spec.kind).toBe('read');
    expect(tool.spec.name).toBe('search_knowledge');

    const result = await tool.handler.execute(
      { query: 'quick brown fox' },
      {
        actor: { id: 'u1' },
        threadId: 't',
        runId: 'r',
        requestId: 'r',
      },
    );
    expect(result).toMatchObject({ passages: [{ source: 'fox' }] });
  });

  it('rejects malformed input', async () => {
    const tool = createRetrievalTool(
      new EmbeddingRetriever(new FakeEmbeddingProvider(), new MemoryVectorStore()),
    );
    await expect(
      tool.handler.execute(
        { notQuery: 1 },
        {
          actor: { id: 'u1' },
          threadId: 't',
          runId: 'r',
          requestId: 'r',
        },
      ),
    ).rejects.toThrow(/query/);
  });
});
