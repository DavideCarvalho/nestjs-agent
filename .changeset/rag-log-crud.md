---
'@dudousxd/nestjs-agent-store-mikro-orm': minor
---

Round out `MikroOrmRagIngestionLog` with the operations a document listing actually needs.

- `remove(documentId)` / `removeByCollection(collection)` — deleting a document from a knowledge base
  has to clear its record too, and deleting a collection has to clear all of them. Without these a
  caller had to reach past the service into the entity manager.
- `listPage()` returns `{ rows, total }`, and `list()` accepts `offset`. The existing `list()` capped
  at 200 with no way to tell a full result from a truncated one, so a caller rendering it had no
  way to know it was showing a partial list — silent truncation reads as completeness.
