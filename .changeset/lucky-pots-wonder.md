---
'@dudousxd/nestjs-agent-rag': minor
---

RAG: change a document's metadata without re-embedding it.

`VectorStore` could `upsert` (which needs the text and a fresh embedding) and `remove` — so a
consumer whose documents get re-classified had to either re-embed a whole document to change a
string, or refuse to stamp the mutable dimension onto chunks at all and resolve it at query time
instead, turning a filter the index could apply into a join the caller has to.

New `updateMetadata(documentId, patch): Promise<number>` rewrites the metadata of every chunk of a
document and touches neither its text nor its embeddings, returning the number of chunks written.
The patch is a shallow JSON Merge Patch (RFC 7386): keys absent from it keep their stored value,
`null` removes a key, `undefined` is ignored (it does not survive a JSON hop, and it is what a spread
produces by accident), and values — arrays above all — are replaced wholesale, since an array-valued
key is a set-valued dimension. An unknown document id returns `0` rather than throwing, matching
`remove`: this is a reconciliation-shaped call that races with ingestion by construction.

Implemented for all three shipped adapters. In `RedisVectorStore` the point of care is that metadata
is stored **twice** — as `meta_<field>` TAGs (what RediSearch filters on) and as a `metadata_json`
blob (what comes back on a `Passage`) — so the update rewrites both from the same merged object and
`HDEL`s the TAG of a removed key; updating one and not the other would leave a chunk that filters as
one value but reports another. Also exports `applyMetadataPatch` so a custom `VectorStore` can
implement the same semantics.
