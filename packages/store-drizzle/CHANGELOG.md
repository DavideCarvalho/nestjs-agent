# @dudousxd/nestjs-agent-store-drizzle

## 0.8.2

### Patch Changes

- [`fe9fb99`](https://github.com/DavideCarvalho/nestjs-agent/commit/fe9fb9985131643ad9b2733a3c3658decdc585ab) - Add NestJS 12 to the supported peer range.

  Every `@nestjs/common`, `@nestjs/core` and `@nestjs/platform-express` peer that read
  `^10.0.0 || ^11.0.0` now reads `^10.0.0 || ^11.0.0 || ^12.0.0`. NestJS 12.0.1 shipped the framework
  as pure ESM and raised its floor to Node >= 20.19; these packages are already `"type": "module"`,
  so nothing needed porting — the turn loop, the `/api/agent/*` controllers, HITL approval as a durable
  signal, the stores and the dashboard all behave identically on 11 and 12.

  The dev and test matrix moved to the 12.x line with the ranges, including the demo app, so the added
  range is tested rather than merely declared: build, both typecheck passes, and the unit and
  database suites are green against 12.0.1.

  11 and 10 stay in every range. Nothing in the source depends on a 12-only API, so the widened range
  is additive and a consumer still on 11 sees no change.

## 0.8.1

### Patch Changes

- Updated dependencies [[`70f3d57`](https://github.com/DavideCarvalho/nestjs-agent/commit/70f3d57dcebd9aec631adc66c40d0715472115d9)]:
  - @dudousxd/nestjs-agent-core@0.12.0

## 0.8.0

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

## 0.7.1

### Patch Changes

- Updated dependencies [[`70114eb`](https://github.com/DavideCarvalho/nestjs-agent/commit/70114ebb9a7a3702d2efdb11e0dea6956a7ba8db)]:
  - @dudousxd/nestjs-agent-core@0.10.0

## 0.7.0

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

## 0.6.0

### Minor Changes

- [`3d256d4`](https://github.com/DavideCarvalho/nestjs-agent/commit/3d256d4027c7ad819f8ec908425d52887e67da3f) - Console navigability + paginated, queryable lists:

  - Sections live on ROUTES now — hash routing (`/ai-gateway#/reliability`, `#/approvals`, …),
    deep-linkable on full page load, consistent with the durable console, zero new dependencies.
  - The list surfaces (tool calls, threads, runs) are paginated and filterable end to end:
    `AgentGovernanceQueries` grew `toolCallsPage`/`threadsPage`/`runsPage` (neutral
    `GovernancePageQuery` with typed `where` — REQUIRED members, implemented in both bundled stores
    with real COUNT + offset, deterministic id tiebreaks, case-insensitive title search, one-sided
    day bounds; in-memory testing impls included). The dashboard API speaks the ecosystem's familiar
    wire grammar (`page`, `limit`, `where[field]=value`, unknown field → 400) and the SPA tables get
    prev/next pagination with per-table debounced filters. The latest-N reads remain for the
    telescope bridge.

### Patch Changes

- Updated dependencies [[`3d256d4`](https://github.com/DavideCarvalho/nestjs-agent/commit/3d256d4027c7ad819f8ec908425d52887e67da3f)]:
  - @dudousxd/nestjs-agent-core@0.8.0

## 0.5.1

### Patch Changes

- Updated dependencies [[`6263338`](https://github.com/DavideCarvalho/nestjs-agent/commit/6263338cf86df7b51cb082d5d2d575987cd13383)]:
  - @dudousxd/nestjs-agent-core@0.7.0

## 0.5.0

### Minor Changes

- [`eb3aaff`](https://github.com/DavideCarvalho/nestjs-agent/commit/eb3aaff531cc923de1d0bccebb2b0690b4c92263) - Governance wave — approvals inbox, tool stats, prompt hash:

  - **HITL approvals inbox**: new `AGENT_APPROVAL_PORT` SPI (`AgentApprovalPort`) bound by the agent
    runtime — console-side approve/reject routed through the SAME decision path chat approvals use
    (durable signal or inline resolution), WITHOUT re-authorization (the console's own guards front
    it). `Decision` gained optional `executedByRef`; the loop persists the decider on both executed
    and rejected action tools (`decision.executedByRef ?? the run's actor`). Governance read
    `pendingApprovals(limit)` (oldest first, joined to thread/actor). Dashboard: Approvals section
    (pending list, approve/reject with reason, nav badge) + `GET approvals` / `POST
approvals/:toolCallId`; new `approvalActorRef` dashboard option stamps WHO decided from the live
    request; the API returns 501 (and the SPA renders read-only) when no port is bound.
  - **Tool governance**: `toolStats(range)` — per-tool calls/failed/rejected + p95 executionMs —
    and a dashboard Tools section.
  - **Prompt hash**: each run records the sha256 of its resolved system prompt (pre-RAG, so it
    identifies the prompt VERSION), surfaced on recent runs in the dashboard — correlate error-rate
    shifts with prompt changes.

### Patch Changes

- Updated dependencies [[`eb3aaff`](https://github.com/DavideCarvalho/nestjs-agent/commit/eb3aaff531cc923de1d0bccebb2b0690b4c92263), [`781a30f`](https://github.com/DavideCarvalho/nestjs-agent/commit/781a30f6579d5b9a69f341b8eeac02c273dbb8a1)]:
  - @dudousxd/nestjs-agent-core@0.6.0

## 0.4.0

### Minor Changes

- [`1c44152`](https://github.com/DavideCarvalho/nestjs-agent/commit/1c4415295a6280527e762f13e6aed48099ae5ca5) - Run reliability metrics — run outcomes are now durably recorded and surfaced as governance reads
  and a dashboard Reliability section:

  - Store SPI: optional `recordRunStart`/`recordRunEnd`/`bumpRunRetries` on `AgentStore` (absent =
    graceful no-op). The loop records start/completed (with duration) as checkpointed steps; the
    runners (durable workflow + inline) record failures with error code/message. Both bundled store
    adapters ship the new `agent_run` table (autoSchema-managed, in the managed-tables lists).
  - `AgentGovernanceQueries` grew `runMetrics`, `runsByAgent`, `runErrors`, `runTrend`, `recentRuns`
    (REQUIRED members — external adapters must implement them; return zeros/empty when the backing
    store never records runs). In-memory testing impls included.
  - Dashboard: `GET <api>/reliability?from&to` + `GET <api>/runs?limit`, and a Reliability section in
    the SPA — success/error rate, retries, p95 duration, run/failure trend, failure breakdown by
    error code, recent runs table.
  - `DispatchedLlmInput` carries `runId` so llm-step retries can be attributed to the run; the retry
    counter stays 0 until the durable runtime exposes the attempt number to remote step handlers.

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
