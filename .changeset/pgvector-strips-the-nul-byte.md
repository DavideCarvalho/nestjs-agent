---
'@dudousxd/nestjs-agent-rag': patch
---

`PgVectorStore` strips the NUL byte (0x00) from every id, text, source, metadata and filter binding it sends to Postgres, which rejects it in `text`/`jsonb` columns.
