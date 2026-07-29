---
'@dudousxd/nestjs-agent-store-mikro-orm': minor
---

`MikroOrmRagIngestionLog.iterate()`: a keyset sweep that survives deleting as you go

The log only offered `list`/`listPage` with `limit`/`offset`, so every consumer that had to walk the
whole table hand-rolled the paging. Two of them delete rows mid-sweep — an orphan reconcile drops the
log row for each document it removes — and offset paging cannot express that: a deleted row shifts
every row behind it back by one, so the next `OFFSET` lands past rows nobody ever saw. The workaround
is to advance the offset by only the rows you *kept*, arithmetic that needs a paragraph of comment to
justify and is wrong the moment anything else deletes concurrently.

- **`iterate(where?, options?)`** — an `AsyncIterable<RagIngestionLog>` over every matching row.
  Paging is keyset, not offset: each batch asks for the rows sorting strictly after the last row
  yielded, using `(updatedAt, documentId)` — a point in the page order, total because it ends in the
  primary key. A cursor made of column values read off a row already in hand does not move when rows
  leave the table, so **deleting while iterating is safe by construction**, including when every row
  shares one `updatedAt` (a bulk upload) and only the tiebreaker separates the batches.
  `options.batchSize` sets the rows per round-trip (default 200), `options.after` resumes from a
  cursor an earlier sweep stopped on. Each batch runs on a **fresh forked EntityManager**, so a long
  sweep does not accumulate an identity map of every row it ever saw.

  The guarantee is stated exactly on the method, including what it is *not*: it is not a snapshot.
  A row inserted or re-ingested mid-sweep is stamped `now`, which sorts ahead of a cursor already
  past it, so against a concurrent writer `iterate` is "at most once", not "at least once".

- **`listDocumentIds(where?, options?)`** — every matching document id, in page order, with no
  200-row cap. It sweeps on the same keyset and selects two columns instead of hydrating whole
  entities, so collecting the id set of a collection no longer drags every `error` TEXT column
  through the heap to discard it.

- **`listPage({ orderBy })`** — the page order is now overridable and documented, and the constant is
  exported as `RAG_INGESTION_LOG_PAGE_ORDER`. Callers that needed a different order were bypassing
  the class entirely rather than depending on an undocumented internal. **The default is unchanged**
  (`updatedAt` desc, `documentId` asc); omitting `orderBy` behaves exactly as before.

Also exported: `RagIngestionLogWhere`, `RagIngestionLogPageQuery`, `RagIngestionLogCursor`,
`RagIngestionLogIterateOptions`. Purely additive — no existing signature or default changed.
