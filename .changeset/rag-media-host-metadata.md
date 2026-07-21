---
'@dudousxd/nestjs-agent-rag-media': minor
---

`MediaIngestionDeps` gains an optional **`metadata`** hook — `(event) => Record<string, unknown>`,
merged OVER the defaults (`mediaId`, `ownerType`, `ownerId`, `collection`, `size`) so a host can add
its own keys or override a default one. Whatever it returns is handed to the vector store as-is; this
package never interprets it.

This is the seam for host-defined retrieval scoping. Until now the chunk metadata was fixed, so any
app needing to stamp its own access-control or routing data had to bypass `ingestMediaFile` and
re-implement the whole read → extract → size-gate → remove → chunk → ingest pipeline. With the hook,
a capability-token ACL is a one-liner and the pipeline stays in the library:

```ts
ingestMediaFile(event, {
  readFile, embedder, store,
  metadata: (event) => ({ collectionId: event.collection, audience: tokensFor(event) }),
});
```

Paired with `@dudousxd/nestjs-agent-rag`'s array-valued (match-any) metadata filters, the stamped
tokens are directly queryable at retrieval time — the store returns only what the caller is entitled
to, without either package knowing what a token means.

Also exports **`mimeFromFileName(fileName)`** — extension → mime type for the common document
formats, the fallback for upload paths that record no content type (S3 objects routinely arrive as
`application/octet-stream`), so ingestion picks the right extractor instead of skipping the file.
Unknown extensions yield `application/octet-stream`, which no default extractor handles, preserving
the skip-don't-index-garbage behaviour.
