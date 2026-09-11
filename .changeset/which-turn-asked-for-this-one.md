---
'@dudousxd/nestjs-agent-dashboard': minor
'@dudousxd/nestjs-agent-store-drizzle': minor
'@dudousxd/nestjs-agent-store-mikro-orm': minor
'@dudousxd/nestjs-agent-testing': minor
---

Record which run delegated a run.

`RecordRunStartInput.parentRunId` is populated for awaited and detached children alike, by both
runners — and all three stores dropped it on the floor. Each declared its own structural parameter
for `recordRunStart` (`{ runId; threadId; actorRef; agentName?; promptHash? }`) instead of the SPI's
input, so a field added to the input was accepted and discarded with nothing to fail.

What that costs is the delegation tree. The durable runtime journals the parent→child edge, but only
there: a reader of run ROWS — every reliability and cost surface — cannot pair a child with the turn
that asked for it, so a delegation's spend is unattributable. For a **detached** child it is worse,
because it outlives its parent's turn, so nothing in the transcript pairs them either.

Both SQL adapters gain a nullable `parent_run_id` column on `agent_run` and persist it; the
in-memory store carries it on its run row and its `GovernanceRunRow`. All three now take
`RecordRunStartInput` itself, so the next field cannot drift the same way, and each adapter's spec
round-trips a fixture typed `Required<RecordRunStartInput>` — which fails to COMPILE until the row
can name what the input carries.

The console reads the edge off `RecentRunRow`: the run drill-down names the run that delegated the
one being read, which for a detached child is the only link back to the turn that asked for it.

**Upgrading.** Nothing to run by hand on either adapter.

- MikroORM: `ensureAgentSchema` heals it, and the column is appended last, so the diff is a plain
  `alter table agent_run add column parent_run_id text null` on every dialect — no SQLite table
  rebuild.
- Drizzle: `CREATE TABLE IF NOT EXISTS` is inert against an existing table, so `parent_run_id` is
  also registered in the additive-column pass and lands on the next boot.

Runs recorded before the upgrade keep `parent_run_id` null: the edge for a turn that has already
finished exists only in the durable journal, and is not backfilled.
