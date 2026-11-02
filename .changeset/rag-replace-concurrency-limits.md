---
'@dudousxd/nestjs-agent-rag': patch
---

`RedisVectorStore.removeMany` and `removeWhere` wait for a `replaceDocument` in progress, so they can't leave part of a document behind. `RedisVectorStore.replaceDocument` swaps a document in one script, so a search no longer sees both versions; a document of more than 256 chunks is still written in steps. In `MemoryVectorStore`, `remove`, `removeMany` and `removeWhere` take their turn with `replaceDocument`.
