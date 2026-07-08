---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent-store-mikro-orm": minor
"@dudousxd/nestjs-agent-store-drizzle": minor
"@dudousxd/nestjs-agent-testing": minor
"@dudousxd/nestjs-agent-codegen": minor
---

Drop unused thread fields that never had a writer.

- **`ThreadSummary.pinnedAt` removed.** The pin field was read-only forever — no store or endpoint ever set it, so it always serialized as absent. Dropped from the core `ThreadSummary` type, the MikroORM / Drizzle schemas + DDL, the in-memory store, and the codegen wire type. A real "pin thread" feature can add it back paired with a `setPinned` writer.
- **`summary` / `summaryMessageCount` columns removed.** Vestiges of a thread-summarization feature that never shipped — born `null` / `0` and never updated. Dropped from both store schemas and their `CREATE TABLE` DDL.
- **`UsagePurpose` narrowed to `'chat' | 'follow_ups'`.** The `'title'` and `'summary'` variants were never recorded. The two live purposes are the only ones a store or dashboard will ever see.
