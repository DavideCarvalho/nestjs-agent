import { MemoryVectorStore } from '@dudousxd/nestjs-agent-rag';
import { FakeEmbeddingProvider } from '@dudousxd/nestjs-agent-testing';
import { describe, expect, it } from 'vitest';
import type { MediaAttachEvent } from './media-events.js';
import { ingestMediaFile } from './media-ingestion.js';
import { mimeFromFileName } from './text-extractor.js';

const EVENT: MediaAttachEvent = {
  id: 'doc-1',
  ownerType: 'user',
  ownerId: 'u1',
  collection: 'knowledge-base',
  disk: 'docs',
  path: 'notes.txt',
  size: 11,
  mimeType: 'text/plain',
};

function deps(extra?: Partial<Parameters<typeof ingestMediaFile>[1]>) {
  const store = new MemoryVectorStore();
  return {
    store,
    args: {
      store,
      embedder: new FakeEmbeddingProvider(),
      readFile: async () => Buffer.from('hello world'),
      ...extra,
    },
  };
}

describe('ingestMediaFile metadata', () => {
  it('stamps the default metadata when no host hook is supplied', async () => {
    const { store, args } = deps();
    await ingestMediaFile(EVENT, args);

    const [document] = await store.listDocuments();
    expect(document?.metadata).toMatchObject({
      mediaId: 'doc-1',
      ownerType: 'user',
      ownerId: 'u1',
      collection: 'knowledge-base',
      size: 11,
    });
  });

  it('merges host metadata over the defaults', async () => {
    const { store, args } = deps({
      metadata: (event) => ({ audience: ['public', `base:${event.ownerId}`] }),
    });
    await ingestMediaFile(EVENT, args);

    const [document] = await store.listDocuments();
    // added by the host...
    expect(document?.metadata?.audience).toEqual(['public', 'base:u1']);
    // ...without dropping the defaults
    expect(document?.metadata?.mediaId).toBe('doc-1');
  });

  it('lets host metadata override a default key', async () => {
    const { store, args } = deps({ metadata: () => ({ collection: 'overridden' }) });
    await ingestMediaFile(EVENT, args);

    const [document] = await store.listDocuments();
    expect(document?.metadata?.collection).toBe('overridden');
  });

  it('host metadata is queryable as a retrieval filter (the ACL use case)', async () => {
    const { store, args } = deps({ metadata: () => ({ audience: ['role:ADMIN'] }) });
    await ingestMediaFile(EVENT, args);

    const embedding = (await args.embedder.embed(['hello world']))[0] ?? [];
    const allowed = await store.search(embedding, {
      topK: 5,
      filter: { audience: ['public', 'role:ADMIN'] },
    });
    const denied = await store.search(embedding, {
      topK: 5,
      filter: { audience: ['public', 'role:BASE_USER'] },
    });

    expect(allowed.length).toBeGreaterThan(0);
    expect(denied).toEqual([]);
  });
});

describe('mimeFromFileName', () => {
  it('maps the common document extensions', () => {
    expect(mimeFromFileName('notes.md')).toBe('text/markdown');
    expect(mimeFromFileName('data.CSV')).toBe('text/csv');
    expect(mimeFromFileName('sheet.xlsx')).toBe(
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    );
    expect(mimeFromFileName('rag/col/a-b-c.json')).toBe('application/json');
  });

  it('falls back to octet-stream for unknown or missing extensions', () => {
    expect(mimeFromFileName('mystery.bin')).toBe('application/octet-stream');
    expect(mimeFromFileName('noextension')).toBe('application/octet-stream');
  });
});
