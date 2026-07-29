---
'@dudousxd/nestjs-agent-dashboard': minor
---

Sections that fetch only when you open them, fail out loud, and open their rows

The governance console had one `refetchInterval: 5000` on the QueryClient, every one of its eleven
queries mounted unconditionally at the top of `App`, and no error boundary anywhere. Those three
facts compound: opening any single section fetched all nine, forever, and when a read failed the
section rendered its empty state — "no spend in this range" is what a governance console said when
the truth was "I could not ask".

**One container per section, each owning its own reads.** `src/app/containers/` replaces the wall
of hooks in `App` and the props drilled down through `ActiveSection`. A section that is not on
screen issues no requests: loading Spend now costs `spend` + `top-threads`, and navigating to
Reliability adds `reliability` and nothing else. The shell keeps two data sources of its own,
because both have to outlive the section being viewed — the SSE subscription (reopening it per nav
would reset the feed and make the header's connection dot lie) and the pending-approvals count
behind the nav badge, which is the one number that must be true while an operator is looking
somewhere else. It reads `approvalsPage({ page: 1, pageSize: 1 }).total`.

**An error boundary per section, and error copy that says what to do.** A failed read now names
itself, shows what the server actually said, and offers a retry when retrying could plausibly
help — `describeError` distinguishes an unreachable API from a rejected session from a `501` that
means "this host bound no store", because those lead to three different next actions and a red box
saying "error" leads to none. Paged tables render their failures INLINE, next to the last page that
did load, rather than throwing the whole section away over one bad page.

**The interval is gone.** Freshness is `staleTime` per query plus react-query's own
`refetchOnWindowFocus`, which the old config had explicitly disabled — fresh the moment someone
looks, silent when the tab is in the background. Day-range aggregates go stale after a minute (a
minute of traffic moves a 30-day rollup by a rounding error), activity lists after fifteen seconds,
the HITL queue immediately, pricing after five.

Removing the poll made the invalidation gaps it was hiding load-bearing, so both mutations were
audited against what they actually change:

- Deciding an approval invalidated `['approvals']` alone. It also flips that tool call's status,
  which `tool-calls`, `tool-calls-page` and an open `run-detail` all render, and a rejection
  increments the tool's `rejected` count in `tool-stats`. All of them now.
- Upserting a price invalidated `['pricing']` alone. Cost is priced at READ time —
  `governance/compute.ts` estimates from the price table for every ledger row with no
  provider-reported cost — so a price edit retroactively restates historical spend. `spend`,
  `top-threads` and `thread-detail` are invalidated too, or the console shows a new rate next to
  totals computed from the old one.

**Suspense for a section's spine, plain queries for its tables.** `useSuspenseQuery` gives loading
and error handling for free but has no `placeholderData`, so a paged table on it would unmount into
a fallback on every page click. It also waterfalls, which is measured rather than assumed: with two
suspense hooks side by side, loading Spend against a dead API issued `spend` twice and `top-threads`
zero times, because the first throws and the render never reaches the second. Equal-standing reads
go through `useSuspenseQueries` now.

**Wired up what the server gained in 0.13.** The approvals inbox is paged over `approvals-page` and
states its backlog outright ("2 of 7 waiting") instead of silently truncating at 50 — a queue that
hides its own depth is the worst failure a human-in-the-loop surface has. Every table row opens a
drill-down drawer: a run shows its full error text (the table could only truncate it), its thread
headline and its tool calls; a thread shows its lifetime token/cost rollup, its newest runs and its
newest messages, and links to `#/reliability?threadId=…` for all of them, which works because
`where[threadId]` on `runs-page` no longer 400s. A `404` from either detail says the row is gone
rather than showing a generic failure. The drawer is a native `<dialog>`, so the focus trap, the
inert background and Esc-to-close come from the platform. The Tools table shows p50 next to p95.

`ToolCallActivityRow.runId`, `PendingApprovalRow.runId` and `ToolStatRow.p50ExecutionMs` are
REQUIRED in the typed client now. They were optional only because the previous change did not own
the mock data that would have broken; the server has always sent all three, and a drill-down that
has to null-check a field the API guarantees is a drill-down written against a lie.

Section-local page and filter state is a deliberate trade: leaving a section and returning clears
its filters, in exchange for eight unviewed sections not holding page state for tables they are not
rendering. Filters worth surviving a nav belong in the URL, which is what the `threadId` deep link
is.
