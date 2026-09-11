---
'@dudousxd/nestjs-agent-store-drizzle': minor
'@dudousxd/nestjs-agent-store-mikro-orm': patch
'@dudousxd/nestjs-agent-testing': patch
---

Persist and return a thread's `defaultAgent` on every adapter.

`AgentStore.updateThread({ defaultAgent })` decides which agent answers the next turn on a thread
when the caller names none. Neither SQL adapter could answer with it.

**Drizzle had no `default_agent` column at all** — not in `schema.ts`, not in its DDL — and no
`updateThread`, so a host on that adapter got a 501 from `PATCH /agent/threads/:id` and could never
set the field. It now has the column, `updateThread` (title and/or `defaultAgent`, each touched only
when present in the patch, `null` clearing the default), and the read side below.

**MikroORM had the column and wrote it, but `toSummary` never emitted it**, so `getThread` reported
no default agent and the next turn silently fell through to the module default. The stored value was
reachable only by querying the entity directly, which is what its own test did — the round-trip
through the store was never exercised.

Both adapters now report `defaultAgent: string | null` on every thread summary/detail, and a fork
carries the source thread's default (the in-memory reference store too — a fork continues the same
conversation, so the same agent answers it).

A `Required<UpdateThreadInput>` fixture in each adapter's db spec and in
`packages/testing/src/thread-fields.spec.ts` fails to COMPILE when the patch gains a field the
adapter does not round-trip — the same gate `message-fields.spec.ts` uses, which is what caught two
silently-dropped message fields.

**Upgrading.** Drizzle's `ensureAgentSchema` is `CREATE TABLE IF NOT EXISTS`, inert against a table
that already exists, so `default_agent` is added through the additive-column pass it already runs at
boot — an existing deployment calling `ensureAgentSchema` needs no action. A host running its own
drizzle-kit migrations instead must add `ALTER TABLE agent_thread ADD COLUMN default_agent TEXT`.
MikroORM needs nothing: the column already shipped.
