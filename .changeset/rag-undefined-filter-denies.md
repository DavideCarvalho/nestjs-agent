---
'@dudousxd/nestjs-agent-rag': minor
---

An `undefined` filter value now matches nothing, in every store. On pgvector it used to drop the key and match every row, so `new FilteredRetriever(base, { tenantId: undefined })` returned all tenants and `removeWhere({ tenantId: undefined })` deleted the table. `removeWhere` now throws `UnsafeRemovalError` with reason `undefined-value`. If you pass `{ lang: maybeUndefined }` to mean "no filter", omit the key instead.
