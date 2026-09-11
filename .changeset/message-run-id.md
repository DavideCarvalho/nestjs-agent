---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent-store-mikro-orm': minor
'@dudousxd/nestjs-agent-store-drizzle': minor
'@dudousxd/nestjs-agent-testing': minor
'@dudousxd/nestjs-agent-evals': patch
---

Record which run wrote each message.

`AppendMessageInput`/`StoredMessage` gain an optional `runId`, persisted by all three store adapters,
and the loop stamps it on the user message and on every assistant message. Until now nothing tied a
message to a turn, so a reader could only compare timestamps against the run's `startedAt` — and a
regenerate breaks that comparison: it truncates the replaced answer and re-answers the surviving user
message without appending a new one, leaving one prompt followed by the newest answer. Walking
forward by time then hands the older run the replacement's text.

`GovernanceRunSampleSource` (`-evals`) now attributes on the stamp. A transcript carrying no stamp at
all is treated as legacy and still resolved by time; a stamped transcript holding nothing for a run
reads as empty for that run rather than borrowing a neighbour's answer. A regenerated run may still
borrow the prompt it re-answered — that message genuinely is its input — but never an answer.

The MikroORM adapter adds the column on its next boot through the schema heal it already runs. The
Drizzle adapter's `ensureAgentSchema` was `CREATE TABLE IF NOT EXISTS` only, inert against an
existing table, so it gains an additive-column pass that adds `run_id` where the table predates it.
