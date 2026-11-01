---
'@dudousxd/nestjs-agent-rag-media': patch
---

`ingestMediaFile` embeds before removing the previous chunks, so a provider failure no longer drops the document from the index.
