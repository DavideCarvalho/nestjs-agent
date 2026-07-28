---
'@dudousxd/nestjs-agent-store-mikro-orm': patch
---

**`MikroOrmRagIngestionLog.list()` / `listPage()` now page deterministically — a document can no longer fall between two pages.**

Both methods ordered by `updatedAt DESC` with no tiebreaker before applying `limit`/`offset`. `updatedAt` is not a total order: a bulk upload stamps every document of the batch with the same second, and the database is free to return tied rows in a different sequence for each LIMIT/OFFSET query. A tie straddling a page boundary therefore handed a caller sweeping the table a row in *neither* page — or the same row in both.

The ordering is now `{ updatedAt: 'desc', documentId: 'asc' }`. `documentId` is the entity's primary key, so the order is total and consecutive pages are disjoint.

This mattered most to callers that sweep the whole table rather than render one page. A missed row means an orphan cleanup deletes the log row while leaving the document's storage object behind unreferenced and unfindable, and a reconcile pass re-embeds documents it already has while reporting inflated counts. Within a page the visible ordering is unchanged except that rows tied on `updatedAt` are now returned in a stable, id-ascending sequence instead of an arbitrary one.
