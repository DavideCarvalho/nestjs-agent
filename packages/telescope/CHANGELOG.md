# @dudousxd/nestjs-agent-telescope

## 0.8.1

### Patch Changes

- [#67](https://github.com/DavideCarvalho/nestjs-agent/pull/67) [`6b723c6`](https://github.com/DavideCarvalho/nestjs-agent/commit/6b723c6beea86c38b0219b83f602b39cbb34c040) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix paging on the Agent tab's list tables: `Next` did nothing, then stopped responding entirely.

  `resolvePage` and `resolveLimit` read their value behind a `typeof raw === 'number'` guard. That
  rejects every value a real request can carry: the dashboard serializes a panel's query into the URL
  and the host controller passes `@Query()` through verbatim, so `?page=2&limit=20` reaches the
  provider as the **strings** `'2'` and `'20'`. Both fell through to the default, so every request
  returned page 1 — verified against a deployment: `?page=2&limit=5` answered with `page: 1`,
  `limit: 50` and the same 50 rows as `?page=1`.

  The visible failure was worse than a stuck first page. The pager renders the page the _response_
  reports, so `Next` appeared to do nothing; and because the control then keeps computing `page + 1`
  from that pinned `1`, the second click requests the page the UI is already on, React skips the
  re-render, and the pager stops responding at all — `Prev` never re-enables either, short of a reload.

  Both helpers now accept a numeric string as well as a number, and reject anything that is not a
  positive number (`''`, `'banana'`, `'0'`, `'-2'`, `'NaN'`) rather than letting it reach the
  read-model as a `NaN` offset. The existing specs passed real numbers throughout, which is why the
  guard survived; the new ones use the string form the wire actually delivers.

## 0.8.0

### Minor Changes

- [#65](https://github.com/DavideCarvalho/nestjs-agent/pull/65) [`2ab59e2`](https://github.com/DavideCarvalho/nestjs-agent/commit/2ab59e291529f70324e51b9d7a31f5d6e01121a4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Two RAG sections on the Agent tab, and a supported way for a host to put its own panels there.

  The tab had Overview, Spend, Reliability, Activity, Approvals and Tools, and nothing for retrieval — even though the framework ships a full retrieval stack. It now has **Retrieval** (retrievals, zero-hit rate, passages per retrieval, a latency histogram with p50/p95/p99 markers, a top-score histogram, and a retrievals/zero-hits trend) and **Retrieval sources** (retrievals by store, by retriever kind, a per-collection rollup, and the slowest retrievals in the window).

  These are fed by real telemetry — the `aviary:rag:retrieval` events `@dudousxd/nestjs-agent-rag` now emits — not derived from tool-call rows, which cannot distinguish a retrieval that found nothing from one that found exactly what was needed. A new `RagTelescopeWatcher` records them under their own `agent-rag` entry type, which also gives the Entries screen a RAG filter tagged by store, retriever and zero-hit. The type is separate from `agent` on purpose: retrieval is per-tool-call where a run is per-conversation, so sharing one storage window would let retrieval traffic push `run.finished` out of it and quietly zero the Runs and Tokens stats.

  The latency panel is a real histogram, unlike the run-duration pair beside it: retrieval events carry the raw per-call duration, so there are samples to bucket. The score histogram is bound to **one** retriever kind (`query: { retriever: 'embedding' }`) because a cosine similarity, a BM25 score and an RRF rank score share no scale — a histogram over all three has bins that mean a different thing per bar, and the reading it invites ("our scores collapsed") would be a change in traffic mix rather than in retrieval quality.

  These panels read Telescope's own storage rather than the durable `AGENT_GOVERNANCE_QUERIES` read-model, which is a deliberate exception to the preference stated in `agent-data-providers.ts`. There is no durable write to piggyback on: retrieval happens inside the rag package, which holds no store handle, so the durable route would mean a new table plus a migration in `store-mikro-orm`, `store-drizzle` and `testing`, and a row written per retrieval — write amplification on the hot path of the operation an agent performs most often. What it would buy is that a p95 and a zero-hit rate survive a pod restart. The honest consequence, documented in the code: these panels are a live view over Telescope's retention window, not a ledger.

  **Host contributions.** `agentTelescopeExtension({ providers, sections })` registers an application's own data providers and dashboard sections on this page — how an app puts its knowledge-base collections or ingestion activity next to the library's retrieval panels. This has to go through this extension rather than a second one: the UI derives the data request path from the dashboard id (`agent.overview` → `GET /ext/agent/data/:provider`) and the server 404s when the provider's owning extension does not match that segment, so a provider contributed elsewhere is simply unreachable from a panel on this page. Host provider names must sit under their own prefix; anything starting with `agent.` is refused at boot with a message that names it, rather than surfacing as Telescope's generic "contributed by both agent and agent" collision error. Host sections are appended after the built-in ones, so a host's layout can never push a built-in section out of the row it was sized for.

## 0.7.1

### Patch Changes

- Updated dependencies [[`70f3d57`](https://github.com/DavideCarvalho/nestjs-agent/commit/70f3d57dcebd9aec631adc66c40d0715472115d9)]:
  - @dudousxd/nestjs-agent-core@0.12.0

## 0.7.0

### Minor Changes

- [#56](https://github.com/DavideCarvalho/nestjs-agent/pull/56) [`7c27376`](https://github.com/DavideCarvalho/nestjs-agent/commit/7c273763eeb6d5841028612d81acc63b2a8dd4eb) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Page the approvals inbox, open a run or a thread, and report p50 next to p95

  The governance read-model could answer "what happened" but not "how much of it is there" or
  "what happened _here_". Three gaps, one shape of fix.

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

### Patch Changes

- Updated dependencies [[`7c27376`](https://github.com/DavideCarvalho/nestjs-agent/commit/7c273763eeb6d5841028612d81acc63b2a8dd4eb)]:
  - @dudousxd/nestjs-agent-core@0.11.0

## 0.6.1

### Patch Changes

- Updated dependencies [[`70114eb`](https://github.com/DavideCarvalho/nestjs-agent/commit/70114ebb9a7a3702d2efdb11e0dea6956a7ba8db)]:
  - @dudousxd/nestjs-agent-core@0.10.0

## 0.6.0

### Minor Changes

- [`107fcc2`](https://github.com/DavideCarvalho/nestjs-agent/commit/107fcc2c0079f97c3cc9ff8c83f2dc41070244d5) - Trace navigation + paged Agent tab + headless docs:

  - Tool calls carry their `runId` end to end (RecordToolCallInput → both stores' nullable run_id →
    ToolCallActivityRow/PendingApprovalRow), and `RunWhere.threadId` filters runs by thread — every
    activity row can now deep-link to its run's trace.
  - Telescope Agent tab: tool-call/run rows link to the TRACES waterfall (`#/traces/{runId}`,
    internal default); the three activity tables use the paged SPI reads with real pagination
    controls (`paged: true`, telescope >= 1.18, dep floor raised); the dashboard regrouped into six
    coherent sections with no orphan half-width panels.
  - react README documents "Bring your own UI" — the package is headless by design; the snippets
    compile against the current API.

### Patch Changes

- Updated dependencies [[`107fcc2`](https://github.com/DavideCarvalho/nestjs-agent/commit/107fcc2c0079f97c3cc9ff8c83f2dc41070244d5)]:
  - @dudousxd/nestjs-agent-core@0.9.0

## 0.5.1

### Patch Changes

- Updated dependencies [[`3d256d4`](https://github.com/DavideCarvalho/nestjs-agent/commit/3d256d4027c7ad819f8ec908425d52887e67da3f)]:
  - @dudousxd/nestjs-agent-core@0.8.0

## 0.5.0

### Minor Changes

- [`6263338`](https://github.com/DavideCarvalho/nestjs-agent/commit/6263338cf86df7b51cb082d5d2d575987cd13383) - Live-feedback fixes for the Agent tab + automatic dedup:

  - The recent-runs table no longer overflows its card: slimmed to started/run/agent/status/duration/
    error/promptHash (thread/actor/retries/errorCode detail lives in the standalone console; the
    provider row shape is unchanged).
  - Run duration renders as p50/p95 stat panels — the previous `distribution` panel was a permanently
    empty histogram (the governance read has percentiles, not samples).
  - The watcher claims its channels (diagnostics 0.7 claim registry, released on `dispose()`), so the
    generic diagnostics bridge skips them automatically — consumers delete their hand-written
    `agent:*` exclude lists.

### Patch Changes

- Updated dependencies [[`6263338`](https://github.com/DavideCarvalho/nestjs-agent/commit/6263338cf86df7b51cb082d5d2d575987cd13383)]:
  - @dudousxd/nestjs-agent-core@0.7.0

## 0.4.0

### Minor Changes

- [`781a30f`](https://github.com/DavideCarvalho/nestjs-agent/commit/781a30f6579d5b9a69f341b8eeac02c273dbb8a1) - Telescope bridge catches up with the governance data (audit items 1-8, 10):

  - The Agent tab surfaces the durable governance reads: Reliability (success/error rate stats, run
    duration as a `distribution` panel with p50/p95 markers, runs-by-agent, error breakdown, run
    trend, recent runs with promptHash chips and 500-char-capped errorMessage — `DataProvider`
    output bypasses Telescope's entry-level `redact()`, so the provider self-caps), durable recent
    tool calls / threads, pending-approvals count + table, and tool stats.
  - The watcher now records ALL agent diagnostics events — `run.failed`, `delegated`, and
    `retrieved` were silently dropped — driven by the new canonical `AGENT_DIAGNOSTIC_EVENTS` export
    (compile-time-checked against the channel registry) + `agentDiagnosticKey()` helper (core). Pass
    those keys to the generic diagnostics bridge's `exclude` to avoid double-recording (doc note
    added, mirroring the media bridge).
  - `agentTelescopeExtension({ threadHref?, runHref? })` — deep-link columns on every thread/run
    table, matching the durable/media bridges' convention. The watcher gained `dispose()`.
  - The ephemeral event-storage tools provider is deprecated and no longer bundled: the durable
    writes always land before the diagnostics event fires, and only the durable read-model sees
    `pending_approval`, so the ephemeral view had no unique value left.

### Patch Changes

- Updated dependencies [[`eb3aaff`](https://github.com/DavideCarvalho/nestjs-agent/commit/eb3aaff531cc923de1d0bccebb2b0690b4c92263), [`781a30f`](https://github.com/DavideCarvalho/nestjs-agent/commit/781a30f6579d5b9a69f341b8eeac02c273dbb8a1)]:
  - @dudousxd/nestjs-agent-core@0.6.0

## 0.3.5

### Patch Changes

- Updated dependencies [[`1c44152`](https://github.com/DavideCarvalho/nestjs-agent/commit/1c4415295a6280527e762f13e6aed48099ae5ca5), [`1c44152`](https://github.com/DavideCarvalho/nestjs-agent/commit/1c4415295a6280527e762f13e6aed48099ae5ca5)]:
  - @dudousxd/nestjs-agent-core@0.5.0

## 0.3.4

### Patch Changes

- Updated dependencies [[`abb32bc`](https://github.com/DavideCarvalho/nestjs-agent/commit/abb32bc0396c65a59ee2b92a1a8b07d772215e31)]:
  - @dudousxd/nestjs-agent-core@0.4.0

## 0.3.3

### Patch Changes

- Updated dependencies [[`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46), [`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46), [`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46)]:
  - @dudousxd/nestjs-agent-core@0.3.3

## 0.3.2

### Patch Changes

- ad8e446: Behavior-preserving simplification pass across the governance surfaces.

  - **core**: extract the shared, pure governance aggregation helpers
    (`estimateCost`, `bucketByModel`, `bucketByActor`, `bucketByThread`,
    `bucketUsageTrend`, `dayBoundsUtc`) so the cost formula, bucketing, and
    day-bounds math live in one place.
  - **store-mikro-orm / store-drizzle / testing**: the three
    `AgentGovernanceQueries` adapters now only fetch their DB-specific rows,
    map them to the shared `GovernanceUsageInput` shape, and call the core
    helpers — deleting the duplicated cost/bucket/day-bounds code.
  - **codegen**: fix the `USAGE`/`StoredMessage` wire contracts that had
    drifted from core's real types, and inject the four missing controller
    routes (agents catalog, thread rename/promote/truncate-from-message).
  - **telescope**: collapse the eight governance data providers into a single
    `governanceStatProvider(name, fetch, format)` factory.

- Updated dependencies
- Updated dependencies [ad8e446]
  - @dudousxd/nestjs-agent-core@0.3.2

## 0.3.1

### Patch Changes

- [`60dcc7d`](https://github.com/DavideCarvalho/nestjs-agent/commit/60dcc7db3764a7d60cb6e4d586f1c0fe7b05ee04) - Governance queries: add `spendByThread(range, limit)` (top threads by cost) and
  `ActorSpendRow.threadCount`. Cost is now priced through the injected
  `AGENT_PRICING_STORE` instead of reading `agent_model_pricing` directly, and both
  store modules accept a `pricingStore` option so a host can bind its own pricing
  table as the single source of cost truth for every governance surface. Default
  behavior (the store's own pricing table) is unchanged.

  The dashboard (`/ai-gateway`) and the Telescope Agent tab gain a "Top threads by
  cost" panel fed by `spendByThread`.

- Updated dependencies [[`60dcc7d`](https://github.com/DavideCarvalho/nestjs-agent/commit/60dcc7db3764a7d60cb6e4d586f1c0fe7b05ee04)]:
  - @dudousxd/nestjs-agent-core@0.3.1
