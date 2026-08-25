# @dudousxd/nestjs-agent-store-mikro-orm

## 0.14.0

### Minor Changes

- [#72](https://github.com/DavideCarvalho/nestjs-agent/pull/72) [`85fc4ec`](https://github.com/DavideCarvalho/nestjs-agent/commit/85fc4ec944c6d271b122589847199a834cd03a49) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Ship a custom `EntityRepository` per agent entity — `AgentThreadRepository`, `AgentMessageRepository`, `AgentToolCallRepository`, `AgentTokenUsageRepository`, `AgentModelPricingRepository`, `AgentRunRepository` and `RagIngestionLogRepository`.

  Each is wired into its `EntitySchema` and declared on the entity class via `[EntityRepositoryType]`, so a host app can resolve one by type — `em.getRepository(RagIngestionLog)` or `@InjectRepository(RagIngestionLog)` in a Nest provider — instead of passing the entity class to every `em.find(RagIngestionLog, …)` call. The generated schema is unchanged: the boot fingerprint in `ensureAgentSchema` hashes tables, columns, indexes and collation only, so no host re-heals.

## 0.13.0

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

- [#59](https://github.com/DavideCarvalho/nestjs-agent/pull/59) [`d115cb7`](https://github.com/DavideCarvalho/nestjs-agent/commit/d115cb7973aafa539eafbb1e488259044a562069) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Stop a `core` minor from promoting half the monorepo to 1.0.0.

  Five packages declared their peer dependency on `@dudousxd/nestjs-agent-core` as `workspace:*`. Changesets treats a peer-dependency bump as breaking for the dependent, and "breaking" on a `0.x` package means `1.0.0` — so the moment `core` took a minor, `ai-sdk`, `rag`, `store-mikro-orm`, `testing` and `transport-redis` were all queued to publish as `1.0.0`. `rag-media` went with them by cascade: its own range on `core` was correct, but its `>=0.4.0 <1.0.0` on `rag` stopped being satisfied once `rag` majored.

  The ranges are now `>=0.10.0 <1.0.0`, matching what `dashboard` and `rag-media` already declared. `onlyUpdatePeerDependentsWhenOutOfRange` is already set in the changesets config, and with a range that a `0.11.0` core still satisfies it does its job. `dashboard` is the control: it peer-depends on `core` too, and it was the one package that did _not_ major, because its range was written this way from the start.

  Verified by running `changeset version` against the same set of changesets before and after: six `1.0.0` bumps become the minors and patches those changesets actually asked for.

  Consumers would have felt this as silence rather than breakage. A dependant on `^0.7.0` of `rag` does not match `1.0.0`, so it simply stops receiving updates, with nothing failing anywhere to say so.

## 0.12.0

### Minor Changes

- [#45](https://github.com/DavideCarvalho/nestjs-agent/pull/45) [`f4c997b`](https://github.com/DavideCarvalho/nestjs-agent/commit/f4c997b5d030f9595678842a21e99cfc3d34c297) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `MikroOrmRagIngestionLog.iterate()`: a keyset sweep that survives deleting as you go

  The log only offered `list`/`listPage` with `limit`/`offset`, so every consumer that had to walk the
  whole table hand-rolled the paging. Two of them delete rows mid-sweep — an orphan reconcile drops the
  log row for each document it removes — and offset paging cannot express that: a deleted row shifts
  every row behind it back by one, so the next `OFFSET` lands past rows nobody ever saw. The workaround
  is to advance the offset by only the rows you _kept_, arithmetic that needs a paragraph of comment to
  justify and is wrong the moment anything else deletes concurrently.

  - **`iterate(where?, options?)`** — an `AsyncIterable<RagIngestionLog>` over every matching row.
    Paging is keyset, not offset: each batch asks for the rows sorting strictly after the last row
    yielded, using `(updatedAt, documentId)` — a point in the page order, total because it ends in the
    primary key. A cursor made of column values read off a row already in hand does not move when rows
    leave the table, so **deleting while iterating is safe by construction**, including when every row
    shares one `updatedAt` (a bulk upload) and only the tiebreaker separates the batches.
    `options.batchSize` sets the rows per round-trip (default 200), `options.after` resumes from a
    cursor an earlier sweep stopped on. Each batch runs on a **fresh forked EntityManager**, so a long
    sweep does not accumulate an identity map of every row it ever saw.

    The guarantee is stated exactly on the method, including what it is _not_: it is not a snapshot.
    A row inserted or re-ingested mid-sweep is stamped `now`, which sorts ahead of a cursor already
    past it, so against a concurrent writer `iterate` is "at most once", not "at least once".

  - **`listDocumentIds(where?, options?)`** — every matching document id, in page order, with no
    200-row cap. It sweeps on the same keyset and selects two columns instead of hydrating whole
    entities, so collecting the id set of a collection no longer drags every `error` TEXT column
    through the heap to discard it.

  - **`listPage({ orderBy })`** — the page order is now overridable and documented, and the constant is
    exported as `RAG_INGESTION_LOG_PAGE_ORDER`. Callers that needed a different order were bypassing
    the class entirely rather than depending on an undocumented internal. **The default is unchanged**
    (`updatedAt` desc, `documentId` asc); omitting `orderBy` behaves exactly as before.

  Also exported: `RagIngestionLogWhere`, `RagIngestionLogPageQuery`, `RagIngestionLogCursor`,
  `RagIngestionLogIterateOptions`. Purely additive — no existing signature or default changed.

## 0.11.2

### Patch Changes

- [#30](https://github.com/DavideCarvalho/nestjs-agent/pull/30) [`f28db24`](https://github.com/DavideCarvalho/nestjs-agent/commit/f28db244b64fa25c054503bdf8469d53000219b1) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **`MikroOrmRagIngestionLog.list()` / `listPage()` now page deterministically — a document can no longer fall between two pages.**

  Both methods ordered by `updatedAt DESC` with no tiebreaker before applying `limit`/`offset`. `updatedAt` is not a total order: a bulk upload stamps every document of the batch with the same second, and the database is free to return tied rows in a different sequence for each LIMIT/OFFSET query. A tie straddling a page boundary therefore handed a caller sweeping the table a row in _neither_ page — or the same row in both.

  The ordering is now `{ updatedAt: 'desc', documentId: 'asc' }`. `documentId` is the entity's primary key, so the order is total and consecutive pages are disjoint.

  This mattered most to callers that sweep the whole table rather than render one page. A missed row means an orphan cleanup deletes the log row while leaving the document's storage object behind unreferenced and unfindable, and a reconcile pass re-embeds documents it already has while reporting inflated counts. Within a page the visible ordering is unchanged except that rows tied on `updatedAt` are now returned in a stable, id-ascending sequence instead of an arbitrary one.

## 0.11.1

### Patch Changes

- [#24](https://github.com/DavideCarvalho/nestjs-agent/pull/24) [`287a720`](https://github.com/DavideCarvalho/nestjs-agent/commit/287a7209a1a89e540f237afd771c65d155601a5e) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The RAG ingestion-log recorder now writes via MikroORM's native `em.upsert(...)` instead of find-then-insert. Two concurrent events for the same new document could race to a duplicate-key insert, which the best-effort catch degraded to a warning — silently dropping the row. The upsert makes insert-or-update atomic while preserving the existing contracts: coordinates a sparser later event omits are left untouched, the outcome-specific columns (`chunks`/`reason`/`error`) stay exclusive per status, and `createdAt` is preserved on update via `onConflictExcludeFields`.

## 0.11.0

### Minor Changes

- [#22](https://github.com/DavideCarvalho/nestjs-agent/pull/22) [`faa6c01`](https://github.com/DavideCarvalho/nestjs-agent/commit/faa6c014a1972a3cebac82d87a2b5c382d5c551b) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Round out `MikroOrmRagIngestionLog` with the operations a document listing actually needs.

  - `remove(documentId)` / `removeByCollection(collection)` — deleting a document from a knowledge base
    has to clear its record too, and deleting a collection has to clear all of them. Without these a
    caller had to reach past the service into the entity manager.
  - `listPage()` returns `{ rows, total }`, and `list()` accepts `offset`. The existing `list()` capped
    at 200 with no way to tell a full result from a truncated one, so a caller rendering it had no
    way to know it was showing a partial list — silent truncation reads as completeness.

## 0.10.0

### Minor Changes

- [#20](https://github.com/DavideCarvalho/nestjs-agent/pull/20) [`fc2981f`](https://github.com/DavideCarvalho/nestjs-agent/commit/fc2981f2ed56ddb46ed7adaa5ea1b65b35d9cbbe) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add `rag_ingestion_log` and `MikroOrmRagIngestionLog` — a record of what RAG ingestion _attempted_.

  A vector store can only enumerate what it has: a document whose extraction produced no text, whose
  mime type had no extractor, or whose embedding call failed has zero chunks, and is therefore
  invisible to `VectorStore.listDocuments()`. Without this, a scanned PDF that silently failed to index
  is indistinguishable from one that was never uploaded.

  The service subscribes to the four `aviary:rag:*` channels `@dudousxd/nestjs-agent-rag-media`
  publishes and upserts one row per document id, so the row always reflects the current state — a
  successful retry clears the error it replaces. It couples to the channel wire contract rather than
  importing `rag-media` (the same convention `rag-media` uses for the media channels it consumes), so
  no new dependency. Writes are best-effort and never throw; a lost row costs observability, not data.

  Registered by `MikroOrmAgentStoreModule.forFeature()` by default — pass `{ ragIngestionLog: false }`
  to opt out. The new table is included in `agentEntities()` and `agentManagedTables()`, so `autoSchema`
  creates it and a host's migration differ skips it.

## 0.9.1

### Patch Changes

- Updated dependencies [[`70114eb`](https://github.com/DavideCarvalho/nestjs-agent/commit/70114ebb9a7a3702d2efdb11e0dea6956a7ba8db)]:
  - @dudousxd/nestjs-agent-core@0.10.0

## 0.9.0

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

## 0.8.0

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

## 0.7.1

### Patch Changes

- Updated dependencies [[`6263338`](https://github.com/DavideCarvalho/nestjs-agent/commit/6263338cf86df7b51cb082d5d2d575987cd13383)]:
  - @dudousxd/nestjs-agent-core@0.7.0

## 0.7.0

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

## 0.6.0

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

## 0.5.0

### Minor Changes

- [#3](https://github.com/DavideCarvalho/nestjs-agent/pull/3) [`abb32bc`](https://github.com/DavideCarvalho/nestjs-agent/commit/abb32bc0396c65a59ee2b92a1a8b07d772215e31) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Implements the (optional) `AgentStore.updateThread` and `AgentStore.activeRunForThread` SPI methods.
  `updateThread` patches `title`/`defaultAgent` — each field only touched when present in the patch, so
  a title-only update never has to know the current `defaultAgent` to preserve it; `defaultAgent` is a
  new additive, nullable column on `agent_thread`, healed in via the existing fingerprint-gated
  `ensureAgentSchema` (no migration). `activeRunForThread` reads the same `activeStreamId` field
  `setActiveStream` already writes — the reverse lookup, keyed by threadId, that lets a client
  reconnecting after a refresh discover a run to reattach to.

  Exports `agentManagedTables()` — the five agent table names, derived from the store's existing
  internal set (never a hand-maintained parallel list) — for a host's own MikroORM schema-diff
  `skipTables`, mirroring `durableManagedTables()` / `telescopeManagedTables()` in the sibling
  `@dudousxd/nestjs-durable` / `-telescope` ecosystem.

### Patch Changes

- Updated dependencies [[`abb32bc`](https://github.com/DavideCarvalho/nestjs-agent/commit/abb32bc0396c65a59ee2b92a1a8b07d772215e31)]:
  - @dudousxd/nestjs-agent-core@0.4.0

## 0.4.4

### Patch Changes

- [`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46) - Carry image/PDF attachments through a chat turn so a vision-capable model sees them natively. A new
  `MessageAttachment` (`{ mediaId, url, contentType, name }`) rides an optional `attachments` field on
  `AgentRunInput`, `AppendMessageInput`, `StoredMessage`, and `ModelMessage`: the chat controller and
  `AgentService` accept it, the loop persists it on the user message and replays it, the MikroORM store
  round-trips it as a JSON column on `agent_message` (auto-added by the additive schema heal — no
  migration), and the AI-SDK adapter renders a user message with attachments as native `image`/`file`
  content parts (`image/*` → image, else file — Bedrock Claude reads a PDF this way). The React
  transport forwards per-send attachments via the request body
  (`sendMessage({ text }, { body: { attachments } })`).

  All fields are optional, so text-only consumers are unaffected. The lib stays provider-agnostic: it
  passes the attachment `url` straight through as the part's source — making that URL reachable by the
  provider (presigned S3, a proxy) is the consumer's concern; the lib never fetches bytes or talks to a
  store.

- Updated dependencies [[`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46), [`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46), [`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46)]:
  - @dudousxd/nestjs-agent-core@0.3.3

## 0.4.3

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

## 0.4.2

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
