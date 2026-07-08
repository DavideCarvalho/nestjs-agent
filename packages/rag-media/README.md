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

## Running ingestion durably

`AgentMediaIngestionModule` ingests inline. For large files or at-least-once guarantees, both this
library and nestjs-media are durable-backed — run the exposed pure function inside a workflow:

```ts
import { ingestMediaFile } from '@dudousxd/nestjs-agent-rag-media';

// inside a @Workflow step, keyed off your own attach hook
await ingestMediaFile(attachEvent, { readFile, embedder, store, extractor });
```

## What it emits

`aviary:rag:media.ingested`, `media.removed`, `media.skipped`, `media.failed` — subscribe for
ingestion metrics, or let the Telescope bridge capture them automatically.

## License

MIT
