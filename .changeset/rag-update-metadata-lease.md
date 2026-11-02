---
'@dudousxd/nestjs-agent-rag': patch
---

`RedisVectorStore.updateMetadata` now takes the same per-document lock as `replaceDocument` and `remove`. Without it, a chunk they deleted mid-update came back as a hash holding only metadata.
