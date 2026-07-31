# @dudousxd/nestjs-agent-rag

Retrieval-Augmented Generation for [`@dudousxd/nestjs-agent`](../nestjs). Chunking, ingestion, an
embedding-backed `Retriever`, and three vector stores — in-memory, pgvector and RediSearch.
Framework-agnostic: it depends only on `-core`, and you bring your own embedding model and (for the
pgvector / RediSearch stores) database driver.

## Install

```bash
pnpm add @dudousxd/nestjs-agent-rag @dudousxd/nestjs-agent-core
```

## Build a retriever + ingest

```ts
import { EmbeddingRetriever, MemoryVectorStore, ingestDocuments } from '@dudousxd/nestjs-agent-rag';
import { aiSdkEmbedding } from '@dudousxd/nestjs-agent-ai-sdk';
import { openai } from '@ai-sdk/openai';

const embedder = aiSdkEmbedding(openai.embedding('text-embedding-3-small'));
const store = new MemoryVectorStore(); // or PgVectorStore for production

await ingestDocuments(
  [{ id: 'refund-policy', text: '…', source: 'docs/refunds' }],
  { embedder, store, chunkSize: 800 },
);

const retriever = new EmbeddingRetriever(embedder, store);
```

## Chunking record-shaped text

The default chunker is structure-blind: it fills a `chunkSize` window, breaks at the latest
paragraph → sentence → word boundary inside it, and carries `overlap` characters across the seam.
That is the right rule for prose — the two halves are still sentences, and the overlap rescues the
one that got cut.

It is the wrong rule for text whose boundaries mean something. A spreadsheet flattened to one
field-labelled record per row has real boundaries the chunker does not know exist, so a cut lands
mid-record routinely — and the half holding the row identifier and the half holding the value end up
in different chunks, where **neither can answer a question about that row**. Tell it where the
records are:

```ts
await ingestDocuments([{ id: 'mvr-2026', text: rows.join('\n') }], {
  embedder,
  store,
  chunkSize: 800,
  separator: '\n', // one record per line; a record is never split across chunks
});
```

Records are packed greedily up to `chunkSize` and never split — except one longer than `chunkSize`,
which has nowhere to go and is character-split as usual. That fallback is confined to the single
record that could not fit, rather than applied to the whole document.

**`overlap` is ignored when `separator` is set**, deliberately. Overlap exists to rescue a sentence a
boundary cut in half; a boundary that never falls inside a record has nothing to rescue, and carrying
the previous chunk's tail in would duplicate whole records into their neighbours — paying for the
same rows twice at embedding time and letting one row match from two places.

Measured on a 200-row, 15-column sheet ingested twice — same bytes, same embedder, same questions,
only the cut positions differing — blind chunking left 27% of records split, and on questions
targeting a field on the far side of such a cut, BM25 answered 54/66 (MRR 0.818) against 66/66
(MRR 1.000) with records kept whole. The dense leg scored 7/66 either way: 200 near-identical rows
produce near-identical vectors, so that leg cannot do row lookup at all and chunking does not change
it. The win is the lexical leg's, and it only shows up on questions whose answer sits far from the
row's rare identifying token — ask about a field next to the vehicle id and both arms score 1.000,
because BM25 finds that token whatever the chunking did around it.

Leave `separator` unset for prose. Nothing about the default path changed.

## Two ways to use it with the agent

**Agentic (default) — the model decides when to search:**

```ts
import { createRetrievalTool } from '@dudousxd/nestjs-agent-rag';
import { provideAgentTool } from '@dudousxd/nestjs-agent';

@Module({ providers: [provideAgentTool(createRetrievalTool(retriever))] })
export class AppModule {}
```

**Inject (always-on) — augment every turn's prompt with retrieved context:**

```ts
AgentModule.forRoot({
  // …model, store, actorResolver…
  retrieval: { mode: 'inject', retriever, topK: 5 },
});
```

Either way, retrieved passages carry a `source` and surface as citations through the normal
tool-call machinery (rendered in the chat UI, shown in the `-telescope` Agent tab). Each retrieval
also emits an `aviary:agent:retrieved` diagnostics event.

## pgvector store

`PgVectorStore` takes an injected `PgClient` — adapt your own `pg` / `postgres.js`:

```ts
import { Pool } from 'pg';
import { PgVectorStore } from '@dudousxd/nestjs-agent-rag';

const pool = new Pool({ connectionString: process.env.DATABASE_URL });
const store = new PgVectorStore(
  { query: (sql, params) => pool.query(sql, params).then((r) => r.rows) },
  { dimensions: 1536 },
);
await store.ensureSchema(); // CREATE EXTENSION vector + table + HNSW cosine index
```

## RediSearch store

`RedisVectorStore` takes anything that can send a raw command — `node-redis`, or `ioredis` wrapped —
so this package pulls in no Redis driver either. Needs the RediSearch module (Redis Stack / Redis 8+):

```ts
import { createClient } from 'redis';
import { RedisVectorStore } from '@dudousxd/nestjs-agent-rag';

const client = createClient({ url: process.env.REDIS_URL });
await client.connect();

const store = new RedisVectorStore(
  { sendCommand: (args) => client.sendCommand(args) },
  { dimensions: 1536, filterableFields: ['audience'] },
);
await store.ensureSchema(); // FT.CREATE: TEXT + TAG + HNSW cosine vector field
```

`filterableFields` declares which metadata keys become filterable `TAG` fields — RediSearch needs them
up front, so only those keys can be used in a `filter`. This store also does lexical search; see below.

`ensureSchema()` belongs at boot. It creates the index if missing — and if the index already exists,
it compares it against your configuration rather than assuming they agree. A `filterableFields` entry
added after the index was created is repaired in place with `FT.ALTER … SCHEMA ADD` (chunks written
before the repair only become filterable on that key once re-ingested). A changed `dimensions` — a
model swap — can't be repaired without a full reindex, so it throws `RedisVectorSchemaMismatchError`
instead of silently leaving the index on the old width.

## Changing metadata without re-embedding

Some metadata is derived from the document's content and only changes when the content does (its
size, its mime type, its ingestion fingerprint). Some isn't: who may see it, which bases or teams it
is relevant to, what it was last classified as. That second kind changes on its own schedule, and
without a way to say so you are left choosing between re-embedding a whole document to change a
string — paying the model bill, and the ingestion budget, for a reclassification — or refusing to
stamp the dimension onto chunks at all and resolving it at query time instead, which turns a filter
the index could have applied into a join you have to.

`updateMetadata` is that way to say so. It rewrites the metadata of **every chunk** of a document and
touches neither the text nor the embeddings:

```ts
// this document now covers bases B and C, and no longer A. No embedding is recomputed.
const chunks = await store.updateMetadata(documentId, { bases: ['B', 'C'] });
```

The patch is applied as a shallow [JSON Merge Patch](https://www.rfc-editor.org/rfc/rfc7386):

| in the patch | effect |
| --- | --- |
| key absent | the stored value is kept — this is a **partial** update, not a replacement |
| `key: value` | the stored value is replaced |
| `key: [a, b]` | replaced **wholesale** — an array is a set-valued dimension, not something to append to |
| `key: null` | the key is **removed**. This is the only way to remove one |
| `key: undefined` | **ignored**, as if the patch had not mentioned the key |

`undefined` is ignored rather than treated as a removal on purpose. It does not survive
`JSON.stringify`, and a patch routinely crosses a JSON boundary (an HTTP body, a workflow step
payload) on its way in, so honouring it would make `{ audience: undefined }` mean *delete* on one
side of that boundary and *no-op* on the other. It is also what `{ ...doc, audience: doc.audience }`
produces by accident — and an accidental deletion of an access-control dimension is the worst thing
this API could do. The cost is that a literal `null` cannot be stored as a value, which is no loss:
"absent" and "null" filter identically anyway.

The return value is the number of chunks written. **An unknown document id updates nothing and
returns `0` rather than throwing** — like `remove`, this is a reconciliation-shaped call, made by a
loop diffing your source of truth against the index, and such a loop races with ingestion and
deletion by construction; an exception would make the ordinary case an error you had to catch and
swallow. (A patch that writes nothing also returns `0`: the count is chunks *written*, not chunks
*matched*.)

Both representations move together. `RedisVectorStore` stores metadata twice — as `meta_<field>`
TAGs, which is what RediSearch filters on, and as a `metadata_json` blob, which is what comes back on
a `Passage` — and `updateMetadata` rewrites both from the same merged object, dropping the TAG of a
removed key rather than leaving it matching a value the document no longer carries. A patched chunk
is indistinguishable from a re-ingested one: filtering on the new value finds it, filtering on the
old value does not, and the metadata read back off a retrieved passage agrees with both. (A plain
`HSET` is all RediSearch needs to re-index — proven against a real Redis Stack, not assumed.)

## Hybrid search (dense + lexical)

`HybridRetriever` fuses several retrievers with Reciprocal Rank Fusion. RRF is **rank**-based, so the
two halves need no common score scale — cosine similarity and BM25 fuse as they are.

There are two ways to get the lexical half, and which one you want is decided by your deployment, not
your taste.

**Store-backed (the default for anything multi-process).** `RedisVectorStore` already declares the
chunk text as a RediSearch `TEXT` field, so the lexical index is *already there* — `LexicalRetriever`
just queries it with BM25:

```ts
import { EmbeddingRetriever, HybridRetriever, LexicalRetriever } from '@dudousxd/nestjs-agent-rag';

const retriever = new HybridRetriever([
  new EmbeddingRetriever(embedder, store),
  new LexicalRetriever(store), // ← same store, no second index
]);
```

### The fused score is not a similarity — do not threshold it

Rank-based fusion is what makes RRF robust across incompatible scales, and the price is that its
output is a function of **rank alone**. It never sees a similarity. Two things follow:

- The score on a fused passage is **not comparable** to the score on one from `EmbeddingRetriever`,
  even though it arrives in the same field, of the same type, through the same `Retriever` interface.
  There is no discriminator — a consumer holding a `Passage[]` cannot tell which kind of number it
  has. If you show scores to a user or a model, know which retriever produced them.
- Its range is narrow, fixed and quality-blind: every possible value lies in
  `[minWeight / (k + fetchTopK), Σ weights / (k + 1)]`, which with the defaults is
  `[0.0125, 0.0328]`. A perfect match and the least-bad member of a set of terrible matches both land
  around `0.016`.

What a fused score measures is how strongly the legs *agree*, and agreement tracks nothing about
correctness: two legs returning the same nearest nothing reinforce it to the same ceiling a unanimous
correct answer gets. Measured on one corpus, the dense leg alone separated cleanly (weakest real
answer `0.244`, loudest absent-topic answer `0.143`) while those same queries after fusion scored
`0.032` and `0.033` — inverted.

So a relevance floor goes on the legs, never on the fusion:

```ts
const retriever = new HybridRetriever([
  new EmbeddingRetriever(embedder, store, { minScore: 0.2 }), // ← floor here
  new LexicalRetriever(store),
]);
```

`HybridRetriever` has no `minScore` of its own on purpose: the option would be an invitation to
apply one to a number that cannot support it.

Nothing else changes: no chunks to hand the retriever, no state in the process, no deletes to mirror.
This is the only option that works when **ingestion and search run in different processes** — a
worker that ingests and an API pod that searches. The API pod never sees the chunks, so an in-process
index there would be permanently empty (or kept warm by scanning the corpus into JS heap on every
pod, which is the workaround this exists to delete). It also means a document is lexically findable
the moment it is upserted, with no refresh window.

`searchText` applies `filter` with exactly the same semantics as `search` — array = OR, **empty array
= deny** — so a lexical hit can never escape a filter a vector hit would have respected. That matters
when the filter is carrying capability tokens rather than a hint.

A query is reduced to letter/digit/`_` terms before it is sent, so RediSearch query syntax in user
input (`*`, `@field:{…}`, `|`, `-`, `=>[KNN …]`) is inert rather than escaped-but-live. A query with
no searchable terms left — empty, whitespace, or pure punctuation — returns `[]` rather than matching
the corpus.

**In-process (`KeywordRetriever`).** Still the right answer for `MemoryVectorStore`, for a store with
no lexical capability, and for single-process deployments where you control both halves. It is a full
BM25 implementation over chunks you feed it, so chunk once and give the SAME chunks to both halves —
their ids line up and `HybridRetriever` can fuse the rankings:

```ts
const chunks = chunkDocuments(docs);
await ingestChunks(chunks, { embedder, store });
keyword.add(chunks); // its own copy of the corpus, in this process only

const retriever = new HybridRetriever([new EmbeddingRetriever(embedder, store), keyword]);
```

Because that is a second index, **deletes have to hit both**, and only this process can see it.
`KeywordRetriever` keeps its own copy of each chunk's text, so a document dropped from the vector
store alone stays fully retrievable — `retrieve` will keep returning the removed passage:

```ts
await store.remove(documentId);
keyword.remove(documentId); // ← the other half. Same document id; chunk ids collapse for you.
```

`KeywordRetriever` also exposes `clear()` and `size` for rebuilding the index wholesale. None of this
bookkeeping exists on the store-backed path above, which is the point of it.

Ask the store which it supports rather than hard-coding:

```ts
import { isLexicalVectorStore } from '@dudousxd/nestjs-agent-rag';

const lexical = isLexicalVectorStore(store) ? new LexicalRetriever(store) : keywordRetriever;
```

### Which stores implement `LexicalVectorStore`

| Store | Lexical | Why |
| --- | --- | --- |
| `RedisVectorStore` | ✅ | RediSearch indexes the chunk text as `TEXT`; BM25 is already there |
| `PgVectorStore` | ❌ | the chunks table has no `tsvector`/GIN index, and adding one is a migration |
| `MemoryVectorStore` | ❌ | single-process by definition — use `KeywordRetriever` |

Postgres is a deliberate omission. Lexical search there needs new DDL (a GIN index), and `CREATE
INDEX` in `ensureSchema` would take a write lock on an already-populated chunks table at boot; it also
forces a text-search-configuration choice that must match between index and query or Postgres silently
falls back to a sequential scan. That wants a migration you run and watch, not a side effect of a
library upgrade. The interface is open, so it can be added later without changing anything else.

## API

- `chunkText(text, { chunkSize?, overlap?, separator? })` — overlapping, boundary-aware chunks;
  `separator` packs whole records instead and never splits one (`overlap` is ignored in that mode).
- `ingestDocuments(docs, { embedder, store, chunkSize?, overlap?, separator? })` — chunk → embed →
  upsert.
- `EmbeddingRetriever(embedder, store, { minScore? })` — the core `Retriever` from an embedder +
  vector store. `minScore` drops passages below a similarity floor, so an unanswerable query can
  return nothing.
- `LexicalRetriever(store)` — the core `Retriever` from a store's own full-text index (BM25).
- `KeywordRetriever` — in-process BM25 over chunks you feed it; the single-process lexical half:
  `add(chunks)`, `remove(documentId)`, `clear()`, `size`.
- `HybridRetriever(retrievers, { k?, fetchTopK?, weights? })` — RRF fusion of the two.
- `MemoryVectorStore` / `PgVectorStore` / `RedisVectorStore` — `VectorStore` adapters:
  `upsert(records)`, `search(embedding, opts)`, `remove(documentId)`,
  `updateMetadata(documentId, patch)`, `listDocuments(filter?)`,
  `listChunks(documentId, { limit?, offset? })`.
- `applyMetadataPatch(metadata, patch)` — the `MetadataPatch` merge semantics, exported so your own
  `VectorStore` can implement `updateMetadata` with exactly the same ones.
- `isLexicalVectorStore(store)` — type guard for the optional `LexicalVectorStore` capability.
- `createRetrievalTool(retriever, { name?, description?, topK? })` — the agentic-retrieval tool.

## Collection maintenance

`remove` and `listDocuments` can only enumerate documents *with* their metadata and delete them *one
at a time*, which makes routine maintenance quadratic-ish: dropping a 2 000-document collection that
way is one `listDocuments()` that parses a metadata blob per chunk, then 2 000 `remove()` calls — and
on Redis each of those is a `SCAN` over the whole keyspace, queues and app cache included.

So `VectorStore` **requires** four more methods, each doing the same work as one filtered query. They
are not an optional capability and there is nothing to narrow to — every store has them:

```ts
await store.countChunks({ collection: 'handbook' });     // FT.SEARCH LIMIT 0 0 / count(*)
await store.listDocumentIds({ collection: 'handbook' }); // ids only — no metadata round-trip
await store.removeWhere({ collection: 'handbook' });     // one query, returns chunks removed
await store.removeMany(['doc-a', 'doc-b']);              // N documents, one pass
```

`removeWhere` is the destructive one, so it has two rules worth knowing before you call it:

| filter | result |
|---|---|
| `{ collection: 'handbook' }` | deletes that scope, returns the chunk count |
| `{ audience: [] }` (or any empty array) | **deletes nothing**, returns `0` — the empty array is this package's deny primitive, and a deny must never be read as "no filter" |
| `{}` | throws `UnsafeRemovalError` — an empty filter is far more often a filter built wrong than a deliberate request to wipe the store |
| `{ notFilterable: 'x' }` (Redis) | throws `UnsafeRemovalError` — the key has no `meta_*` TAG to match on |

Deliberate mass deletion is still available; it just has to be spelled out:
`await store.removeMany(await store.listDocumentIds())`.

`VectorStore.remove` deliberately stays a `SCAN` on the Redis adapter. Turning it into an `FT.SEARCH`
would mean stamping the document id as an indexed field at write time, and chunks written before that
change carry no such field — the search would find none of them and `remove` would silently stop
deleting. The methods above need no new field, so they have no migration.

## Reading chunks back

Everything above enumerates *documents*. The text itself is otherwise write-only: `search` needs an
embedding, `searchText` needs a query, and both return what **matched**, in relevance order, capped
at `topK`. Neither answers "show me what was indexed for this document, in order" — the question you
ask when retrieval returned the wrong passage and you need to know whether the chunker cut badly or
the retriever chose badly.

```ts
const chunks = await store.listChunks('handbook.pdf', { limit: 20 });
// [{ id: 'handbook.pdf#0', index: 0, text: 'Chapter 1 …', metadata: { collection: 'handbook' } }, …]
```

Ordered by `index` (the `n` of `${documentId}#<n>`, numerically — `#10` after `#2`), so paging with
`limit`/`offset` walks the document front to back. A document stored under a bare id is chunk `0`. An
unknown `documentId` yields `[]`.

Document-scoped rather than filter-scoped, matching `remove` and `updateMetadata`: ordering only
means something once a document is picked, so enumerate with `listDocumentIds(filter)` first when you
need to sweep. Two things it deliberately is not:

- **not an access-control seam** — it takes no filter and applies none, so a consumer that gates
  retrieval on a metadata field must resolve that gate itself before calling, exactly as before
  `remove`. It is shaped for an operator/debug surface, not for serving end users;
- **not a hot path** — on Redis it costs one keyspace `SCAN`, the same as `remove`. Fine for one
  document on demand, wrong inside a loop over a corpus.

### Why these are required and `searchText` is optional

A method is **required on `VectorStore`** when every backend can implement it from what it already
stores. Enumeration and bulk deletion are CRUD over records the store already holds — the same
footing as `remove` and `listDocuments` — so making them optional would only cost every consumer a
permanent `if (supported)` and an unreachable "and if it isn't?" branch.

A method goes in an **optional capability interface** when some backend genuinely *cannot* provide it
without infrastructure the consumer has to adopt. `LexicalVectorStore.searchText` is the only one
today, and it earns it: RediSearch has BM25 natively, Postgres needs a `tsvector` column, a GIN index
and a migration you run and watch, and `MemoryVectorStore` would have to implement BM25 itself.

The test is whether a backend can do it at all — not whether adding it would inconvenience an
implementer who has already shipped.
