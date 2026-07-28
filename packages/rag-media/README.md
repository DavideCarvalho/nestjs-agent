# @dudousxd/nestjs-agent-rag-media

Auto-ingest [`@dudousxd/nestjs-media`](https://github.com/dudousxd/nestjs-media) uploads into agent
[RAG](../rag). Attach a file and it becomes searchable by the agent automatically — extract text,
chunk, embed, index — scoped to its owner, with delete kept in sync.

It couples to the media library through the **diagnostics channel** (the same `aviary:media:*` seam
Telescope rides), so there's **no hard dependency on `@dudousxd/nestjs-media`**: you supply a one-line
`readFile` and the integration listens for attach/delete events.

## Install

```bash
pnpm add @dudousxd/nestjs-agent-rag-media @dudousxd/nestjs-agent-rag @dudousxd/nestjs-agent-core
```

## Wire it

```ts
import { AgentMediaIngestionModule } from '@dudousxd/nestjs-agent-rag-media';
import { PgVectorStore } from '@dudousxd/nestjs-agent-rag';
import { aiSdkEmbedding } from '@dudousxd/nestjs-agent-ai-sdk';
import { openai } from '@ai-sdk/openai';

@Module({
  imports: [
    AgentMediaIngestionModule.forRoot({
      store,                          // any VectorStore (PgVectorStore, RedisVectorStore, …)
      embedder: aiSdkEmbedding(openai.embedding('text-embedding-3-small')),
      collections: ['knowledge-base'], // omit = every collection
      // the only glue: read a file's bytes from its media disk
      readFile: (disk, path) => media.disk(disk).get(path),
      // optional, recommended: lets the size limit reject an oversized object before downloading it
      statFile: (disk, path) => media.disk(disk).size(path),
    }),
  ],
})
export class AppModule {}
```

That's it. Now every file attached to the `knowledge-base` collection is chunked, embedded, and
indexed with `{ mediaId, ownerType, ownerId, collection }` metadata; deleting the media record removes
its chunks.

## Owner-scoped retrieval

Because ingestion stamps the owner onto every chunk, a per-user / per-tenant retriever is one wrapper —
the agent (or a crafted query) can't reach across the boundary:

```ts
import { EmbeddingRetriever, FilteredRetriever } from '@dudousxd/nestjs-agent-rag';

const base = new EmbeddingRetriever(embedder, store);
const forThisUser = new FilteredRetriever(base, { ownerId: actor.id });
// pass forThisUser to createRetrievalTool(...) or forRoot({ retrieval })
```

## The size limit

`maxBytes` (default 25 MB) is enforced against the file's **real** byte length, not the `size` the
attach event declares — that number reaches this package from the media record, which in most hosts is
filled in by the client that opened the upload session. A declared size over the limit still
short-circuits early (cheap), but a declared size under it authorizes nothing: the bytes are
re-checked after the read, before extraction and embedding, and it's the real length that gets stamped
into chunk metadata as the fingerprint `reconcileMediaRag` compares against.

Wiring `statFile` moves that authoritative check ahead of the download, so an oversized object is
never fetched at all — and `reconcileMediaRag` uses it too, keeping its drift check honest when a
declared size disagrees with the bytes.

## Text extraction

`defaultTextExtractor()` handles `text/*`, `application/json`, and `text/html` (tag-stripped);
anything else is skipped rather than indexed as binary garbage. Bring your own parser for other
formats — it's a `.register` away:

```ts
import { defaultTextExtractor } from '@dudousxd/nestjs-agent-rag-media';
import pdfParse from 'pdf-parse';

const extractor = defaultTextExtractor().register('application/pdf', async (bytes) =>
  (await pdfParse(bytes)).text,
);

AgentMediaIngestionModule.forRoot({ store, embedder, readFile, extractor });
```

## Ingesting conversions (PDF, OCR)

Instead of parsing binary formats on the RAG side, let the media library's own conversion pipeline
produce the text and ingest **that**. Point `conversions` at the conversion names you want; `resolve`
maps the (bare) conversion event back to an ingestable descriptor — reuse the media record's `id` so
the derived text shares the original's document id (delete-sync then covers it, and a skipped binary
original never wipes it):

```ts
AgentMediaIngestionModule.forRoot({
  store,
  embedder,
  readFile,
  conversions: {
    names: ['text'], // media conversion names to ingest; others ignored
    resolve: async ({ id, path }) => {
      const record = await mediaLibrary.find(id);
      if (!record) return null;
      return {
        id, // same document id as the original
        ownerType: record.ownerType,
        ownerId: record.ownerId,
        collection: record.collection,
        disk: record.conversions.text.disk,
        path, // the converted artifact
        size: record.conversions.text.size,
        mimeType: 'text/plain',
      };
    },
  },
});
```

## Keeping the index in sync

Ingestion is event-driven, so it's eventual and best-effort — it covers the normal
`MediaLibrary.attach()` / `delete()` path, but an event is missed if the process was down when it
fired or a record was deleted straight in the DB. `reconcileMediaRag` repairs that drift: it diffs
your source of truth against the index, ingests what's missing, and removes orphans. Cheap to run on
a schedule or at boot — it only touches the difference.

```ts
import { reconcileMediaRag } from '@dudousxd/nestjs-agent-rag-media';

await reconcileMediaRag(
  { ownerType: 'user', ownerId: actor.id, collection: 'knowledge-base' },
  { store, embedder, readFile, source: { listMedia: (q) => mediaLibrary.list(q.ownerType, q.ownerId, q.collection) } },
);
```

## At-least-once ingestion

`AgentMediaIngestionModule` ingests inline. For large files or an at-least-once guarantee, pass an
`enqueue` hook — attach/delete are handed to your durable queue instead, and a worker replays them
with `applyMediaIngestJob`. Durability stays opt-in; the package pulls in no durable dependency.

```ts
import { applyMediaIngestJob } from '@dudousxd/nestjs-agent-rag-media';

AgentMediaIngestionModule.forRoot({
  store, embedder, readFile,
  enqueue: (job) => durableQueue.add('media-rag', job), // { type: 'ingest' | 'remove', event }
});

// in the durable worker — pass the same config object you gave the module:
await applyMediaIngestJob(job, { store, embedder, readFile });
```

## What it emits

`aviary:rag:media.ingested`, `media.removed`, `media.skipped`, `media.failed` — subscribe for
ingestion metrics, or let the Telescope bridge capture them automatically.

## License

MIT
