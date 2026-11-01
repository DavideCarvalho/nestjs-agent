---
'@dudousxd/nestjs-agent-rag': patch
---

`replaceDocument` no longer leaves a mix of versions when the same document is replaced concurrently. `PgVectorStore` takes an advisory lock per document, which also stops the deadlocks. `RedisVectorStore` gains `replaceDocument`, with a per-document lease that needs `SET` and `EVAL` on the client.
