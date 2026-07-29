---
'@dudousxd/nestjs-agent-store-mikro-orm': minor
'@dudousxd/nestjs-agent-store-drizzle': minor
'@dudousxd/nestjs-agent-dashboard': minor
'@dudousxd/nestjs-agent-telescope': minor
'@dudousxd/nestjs-agent-testing': minor
'@dudousxd/nestjs-agent-core': minor
---

Page the approvals inbox, open a run or a thread, and report p50 next to p95

The governance read-model could answer "what happened" but not "how much of it is there" or
"what happened *here*". Three gaps, one shape of fix.

**The approvals inbox was capped and silently truncating.** `pendingApprovals(limit)` returns a
capped list with no total, so a backlog past the cap was invisible — nothing on screen said so.
That is the worst failure a human-in-the-loop queue can have. `approvalsPage` gives it the same
paged treatment `runsPage`/`threadsPage`/`toolCallsPage` already have, with a `total` and filters
on `toolName`/`threadId`/`actorRef`/`agentName`/day bounds, exposed as `GET approvals-page`.
Ordering is `createdAt asc, id asc` — the `id` makes it a total order, and ascending means a newly
requested approval appends past the last page instead of shifting the page an operator is reading.
`GET approvals` stays: the console's own SPA still calls it, and telescope's inbox table reads the
SPI method directly. Telescope's pending-approvals STAT now reads `approvalsPage(...).total`, which
replaces an explicitly-documented undercount (it counted a 500-row capped list).

**Every table row was a dead end.** `runDetail(runId)` returns a run, its owning thread's headline
and its tool calls; `threadDetail({ threadId, messageLimit, runLimit })` returns a thread, its
lifetime token/cost rollup, its newest runs and its newest messages. One round trip each, and a
fixed query count inside — per-message tool-call counts are one batched read, not one per message.
Exposed as `GET runs/:runId` and `GET threads/:threadId`, 404 on an unknown id (a console that
renders an empty detail instead sends an operator hunting a bug that isn't there). A soft-deleted
thread is returned flagged `deleted: true` rather than 404'd — an audit needs the thread it just
lost. Run detail carries no cost figure: the token ledger has no run column, so per-run spend is
not attributable without a store migration, and inventing a number would be worse than omitting it.

**`toolStats` reported only a tail.** It had p95 and no measure of the typical call, so a tool whose
median is 100ms and whose p95 is 10s looked the same as one that is uniformly slow. Added
`p50ExecutionMs` alongside. Not a mean: latency is long-tailed, and an average of nine 100ms calls
and one 10s call is ~1s — a number no call in the sample ever produced. Percentiles stay in-process
off the sorted sample, as they already were, because MySQL has no `PERCENTILE_CONT` and one portable
implementation beats three dialect-specific ones.

Also in this change:

- `where[threadId]` on `GET runs-page` now works. Every adapter's `RunWhere` already supported it;
  only the query parser rejected it, so "show me this thread's runs" 400'd with "Unknown where
  field" — exactly the follow-up query a drill-down leads to.
- `recentThreads`/`threadsPage` no longer issue two queries per row. Both SQL adapters batch the
  message counts and token totals across the whole page, so a 200-row page costs two statements
  instead of four hundred round trips.
- The typed client (`@dudousxd/nestjs-agent-dashboard/client`) gains `approvalsPage`, `runDetail`
  and `threadDetail`, and picks up `runId` on the tool-call and pending-approval rows — the server
  had been sending it and the mirror had drifted.

`AgentGovernanceQueries` gains three required methods (`approvalsPage`, `runDetail`,
`threadDetail`), matching how the paged reads were added. An out-of-tree adapter implementing the
interface must add them; all three in-tree adapters (MikroORM, Drizzle, in-memory) do.
