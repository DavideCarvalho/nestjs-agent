---
'@dudousxd/nestjs-agent-rag': minor
---

`VectorStore.listChunks(documentId, { limit?, offset? })` — read a document's chunks back, in order.

Stored text was write-only. `search` needs an embedding and `searchText` needs a query; both return
what *matched*, ranked, capped at `topK`, so neither can answer "what was indexed for this document,
in order" — the question you ask when retrieval returns the wrong passage and you need to tell a bad
chunk boundary from a bad ranking. The only way to see it was to reach around the adapter into Redis
or Postgres directly.

Implemented on all three adapters. Ordered numerically by the `n` of `${documentId}#<n>` (so `#10`
sorts after `#2` — a plain `ORDER BY id` gets that wrong past ten chunks), with a bare document id
treated as chunk `0`. An unknown id yields `[]` rather than throwing, matching `remove` and
`updateMetadata`.

It is deliberately not an access-control seam: it takes no metadata filter and applies none, so a
consumer gating retrieval on tenant/audience/collection must resolve that gate before calling, as it
already must before `remove`. On the Redis adapter it costs one keyspace `SCAN`, same as `remove` —
sized for an operator/debug surface, not a hot path.

Also exported: the `StoredChunk` and `ListChunksOptions` types, and `chunkIndexOf(chunkId)`.
