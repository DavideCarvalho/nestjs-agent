---
'@dudousxd/nestjs-agent-store-drizzle': patch
'@dudousxd/nestjs-agent-store-mikro-orm': patch
'@dudousxd/nestjs-agent-testing': patch
---

Name `cancelled` in the row types a run settles into.

`RecordRunEndInput.status` has three terminals — `completed`, `failed`, `cancelled` — but all three
stores declared `recordRunEnd`'s parameter as the narrower `'completed' | 'failed'`, and their run
row and column types listed only those. Method parameters are bivariant, so this typechecked and the
value was written through: the data was right and every reader was told a cancelled run is
impossible. A consumer computing a failure rate had no type-level way to leave a user pressing Stop
out of it.

The parameter, the `AgentRunStatus` column type on both SQL adapters, and the in-memory store's run
rows now all name it. `DrizzleGovernanceQueries` also accepts `cancelled` as a run-status filter —
it previously short-circuited an unrecognized value to an empty page, so an operator could not list
the cancelled runs that were already in the table.

Each adapter's db spec now derives its terminal fixture from `RecordRunEndInput['status']` and the
row's own status type, so a fourth terminal fails to compile until the row can name it. A runtime
test cannot catch this — bivariance means the value round-trips either way.

**Upgrading.** No schema change: `status` is a plain string column on both adapters, with no enum or
check constraint to widen.
