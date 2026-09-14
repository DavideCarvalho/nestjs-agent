---
'@dudousxd/nestjs-agent-rag': patch
---

`PgVectorStore.upsert` and `updateMetadata` strip the NUL byte (0x00) from id, text, source and metadata before writing to Postgres, which rejects it in `text`/`jsonb` columns.
