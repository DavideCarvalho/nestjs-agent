---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent-store-drizzle': minor
'@dudousxd/nestjs-agent-store-mikro-orm': minor
'@dudousxd/nestjs-agent-testing': minor
---

`RecentRunRow.parentRunId` — the delegation edge reaches the read-model.

The run row records which turn delegated it, but the governance read-model did not carry it, so every
surface built on `recentRuns` / `runsPage` / `runDetail` / `threadDetail` still saw a flat list of runs.
`RecentRunRow` gains `parentRunId: string | null`, mapped by all three adapters — `null` for a turn
nobody delegated, and for any run recorded before the column existed.

That is what a console needs to draw a delegation tree and roll a child's cost up to the turn that asked
for it. For a DETACHED child it is the only link there is: it outlives its parent's turn, so nothing in
the transcript pairs them.

`RecentRunRow.status` also stops documenting three terminals. `cancelled` is a fourth value these rows
carry, and a consumer computing a failure rate has to be able to leave it out rather than fold it into
`failed` — a user pressing Stop is not an error.

**Upgrading.** No schema change and no behaviour change; an existing consumer that ignores the new field
is unaffected. A consumer asserting exhaustively on a run row (`toEqual`) will see the added key.
