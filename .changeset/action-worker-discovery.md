---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent-testing': minor
'@dudousxd/nestjs-agent-store-drizzle': minor
'@dudousxd/nestjs-agent-store-mikro-orm': minor
---

Add indexed worker-only proposal discovery to SQL stores: claim queued or expired-lease work across
scopes and expire due pending cards in bounded batches. Every proposal mutation keeps discovery
metadata in the same fenced write. Add a shared worker-store conformance contract and bounded,
version-fenced backfill for existing proposals after additive schema migration.

Stop old writers before applying the migration and repeating backfill batches, then start the new
workers. This capability does not itself enable the independent conversation runtime.
