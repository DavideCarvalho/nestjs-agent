---
'@dudousxd/nestjs-agent-rag-media': minor
---

`media.ingested` now carries the same outcome coordinates (`source`, `size`, `mimeType`) that `skipped` and `failed` already do. An attach event always carries a path/size/mime type, so the fields are required. Previously the ingestion-log recorder wrote `source`/`size`/`mimeType` = null for every SUCCESSFUL document — the one outcome whose payload lacked them — so consumers fell back to ugly document-id names and lost the file size.
