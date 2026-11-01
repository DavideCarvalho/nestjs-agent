---
'@dudousxd/nestjs-agent-rag': patch
---

`RedisVectorStore.remove` waits for a `replaceDocument` in progress, so it can't leave part of a document behind. `MemoryVectorStore` gains `replaceDocument`, which queues calls per document.
