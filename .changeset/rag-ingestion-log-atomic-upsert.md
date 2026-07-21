---
'@dudousxd/nestjs-agent-store-mikro-orm': patch
---

The RAG ingestion-log recorder now writes via MikroORM's native `em.upsert(...)` instead of find-then-insert. Two concurrent events for the same new document could race to a duplicate-key insert, which the best-effort catch degraded to a warning — silently dropping the row. The upsert makes insert-or-update atomic while preserving the existing contracts: coordinates a sparser later event omits are left untouched, the outcome-specific columns (`chunks`/`reason`/`error`) stay exclusive per status, and `createdAt` is preserved on update via `onConflictExcludeFields`.
