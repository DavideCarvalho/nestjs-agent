# @dudousxd/nestjs-agent-core

## 0.7.0

### Minor Changes

- [`6263338`](https://github.com/DavideCarvalho/nestjs-agent/commit/6263338cf86df7b51cb082d5d2d575987cd13383) - Agent run tracing — every run now emits diagnostics SPANS correlated by `traceId = runId`, so the
  Telescope TRACES tab renders the turn as a nested waterfall (llm calls, tool executions, retrieval,
  follow-ups, with durations and error phases):

  - core: four span events (`llm.turn`, `tool.execution`, `retrieval`, `follow-ups`) on the agent
    diagnostics channel, emitted from INSIDE the checkpointed step bodies — replayed (cached) steps
    never re-emit. Payloads are metadata-only (model id, token counts, tool name/type, step index —
    never prompt/output text). `traceLlmTurn`/`traceToolExecution` are exported for remote execution
    sites.
  - nestjs: the dispatched-step handlers (`AgentRunSteps.llm`/`.tool`) emit the identical spans from
    whichever worker actually executes; the dispatch envelopes gained the additive fields the span
    identity needs (`step` on the llm input; `toolCallId`/`toolType` on the tool input).

  Rendering requires the span-aware diagnostics bridge (`@dudousxd/nestjs-diagnostics-telescope`
  0.7+) and `@dudousxd/nestjs-telescope` 1.17+ (explicit `RecordInput.traceId`); without them the
  spans are emitted but unobserved (zero cost — phase envelopes are gated on subscriber presence).

## 0.6.0

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

## 0.5.0

### Minor Changes

- [`1c44152`](https://github.com/DavideCarvalho/nestjs-agent/commit/1c4415295a6280527e762f13e6aed48099ae5ca5) - Dispatched turn steps — opt-in `dispatchedSteps: true` (requires `durable: true`) dispatches the
  turn's two LONG steps as routed durable steps instead of in-process localSteps, so a run is no
  longer pinned to its pod while the model call or a tool executes:

  - `AgentRunSteps.llm` (`@Step({ retries: 3 })`): resolves the model/sink/tool definitions from the
    serving worker's own DI and streams from wherever it runs. `AgentRunSteps.tool` (no retries —
    tool idempotency is the app's domain): rebuilds the tool ctx and applies the tool timeout
    handler-side. Both are ALWAYS registered by `AgentDurableModule` (worker groups always served);
    the flag only controls dispatching. Bookkeeping steps (persist/quota/stream markers) stay local —
    dispatching a 10ms DB write through a queue buys nothing.
  - Core: serializable `LlmStepEnvelope`/`ToolStepEnvelope` (`ToolStepCtx` excludes `host`, re-attached
    from DI handler-side; the llm envelope carries the `actor` and the handler re-derives tool
    definitions — live schema instances never cross the wire), optional `dispatchLlm`/`dispatchTool`
    loop hooks (absent = behavior identical to before), exported `withToolTimeout`.
  - Core: new `AgentLoopHooks.isControlFlowError` — the durable runner's suspend/continue-as-new
    signals now escape the loop's tool catch instead of being mispersisted as tool failures (which
    diverged on replay).
  - Multi-pod fleets MUST wire a cross-process token sink (e.g. `RedisTokenStreamSink`); a boot
    warning fires when `dispatchedSteps` is on with the default in-process sink.

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

## 0.4.0

### Minor Changes

- [#3](https://github.com/DavideCarvalho/nestjs-agent/pull/3) [`abb32bc`](https://github.com/DavideCarvalho/nestjs-agent/commit/abb32bc0396c65a59ee2b92a1a8b07d772215e31) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `AgentModule.forRoot()`/`forRootAsync()` gain a `guards` option (`Type<CanActivate>[]`), stamped
  uniformly on every mounted controller (chat, threads, tool-call, quota, agents, and attachments) via
  `@nestjs/common`'s own `@UseGuards` metadata key with REPLACE semantics — a repeated module
  registration never accumulates guards onto the shared controller classes. Guard classes are added to
  the module's `providers` for DI.

  Tool-related `AgentStreamEvent` frames (`tool-input-start`, `tool-input-available`) now carry an
  additive `toolKind: 'read' | 'action'` (collapsing the `agent` delegation kind into `read`, since
  that's the distinction a client actually needs — approval-gated or not), stamped from the tool
  registry so a UI no longer has to hardcode a tool-name allowlist to know which calls need approval.
  Persisted tool calls (`StoredMessage.toolCalls[].kind`) carry the full `ToolKind` (`read | action |
agent`) for the same reason on the thread-read side.

  Per-step/message token usage now prices into `costUsd: number | null` — on the `step-finish` stream
  frame and the persisted assistant message's `usage` — via the optionally-bound `AGENT_PRICING_STORE`
  (a provider-reported cost wins when the model turn reports one). The price list is fetched once per
  run and reused for every step, not re-fetched per message. `null` (never a fabricated `0`) when no
  pricing store is bound or the model has no price row.

  `AgentStore` gains two OPTIONAL SPI methods so existing stores keep compiling: `updateThread(threadId,
{ title?, defaultAgent? })` and `activeRunForThread(threadId)`. Thread read/list payloads add
  `defaultAgent: string | null` and `activeRunId: string | null` (`null` when the bound store doesn't
  implement the corresponding method). `PATCH /agent/threads/:id` now accepts `{ title?, defaultAgent?
}` (title-only patches still work against any store via the required `setTitle`; a `defaultAgent`
  change 501s with a clear message against a store that lacks `updateThread`). `chat()` without an
  explicit `agentName` on a thread whose `defaultAgent` is set now uses it — explicit `agentName` still
  wins, the module's configured default is the final fallback. `@dudousxd/nestjs-agent-testing`'s
  `InMemoryAgentStore` implements both new methods (the latter by reading the same `activeStreamId`
  field `setActiveStream` already maintains, now correctly cleared to `null` when a run finishes or
  fails instead of staying stamped forever).

  New core SPIs, both optional and unbound by default: `ActorDirectory` (`AGENT_ACTOR_DIRECTORY`) —
  resolves opaque store `actorRef`s to display labels for governance/dashboard read surfaces — and
  `AttachmentStagingStore` (`AGENT_ATTACHMENT_STAGING`) — persists an uploaded file and returns the
  `MessageAttachment` to send with the next chat message. When the latter is bound and
  `AgentModuleOptions.attachments.upload` is `true` (a static flag — controllers are build-time; DI is
  run-time), `POST /agent/attachments` mounts (multipart, single `file` field, buffered in memory,
  validated against a configurable size cap / content-type allowlist) under the same path prefix and
  guards as the other controllers. `upload: true` with nothing bound to `AGENT_ATTACHMENT_STAGING` fails
  boot loudly instead of mounting a controller that would 501 on every request.

## 0.3.3

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

- [`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46) - Stream structured turn events so clients render text, reasoning, and live tool-call cards — not just
  text. The sink now carries an NDJSON `AgentStreamEvent` vocabulary (`step-start`/`step-finish`,
  `text`, `reasoning`, `tool-input-start`/`-delta`/`-available`, `tool-output`/`-error`): the AI-SDK
  adapter emits model parts, the loop emits tool results, the chat controller forwards each line as an
  SSE frame, and the React transport maps them back to the AI SDK UI-message chunk protocol. Tool
  cards (input streaming → rendered output) and reasoning now appear live via `useAgentChat`, matching
  a native `streamText().toUIMessageStream()` while keeping the sink a format-agnostic byte buffer
  (durable buffering/replay untouched).

  Note: this changes the on-the-wire chat SSE protocol from `{delta}` text frames to
  `AgentStreamEvent` frames — upgrade backend (`@dudousxd/nestjs-agent`) and client
  (`@dudousxd/nestjs-agent-react`) together.

- [`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46) - Fix multi-tool agent turns dying with `AI_MissingToolResultsError`. The loop stored a turn's tool
  results on a synthetic `role:"user"` carrier message, but every model adapter's `mapMessages` only
  reads `toolResults` off `assistant` messages — so the results were dropped and the next model call
  saw a tool-call with no matching result. Tool results now ride on the assistant message that made
  the calls (matching the store's one-row shape), so the loop can complete a `read → render` turn.

## 0.3.2

### Patch Changes

- Add a `GET <agentPath>/agents` catalog endpoint that lists the discovered
  `@Agent` classes (`{ name, description, isDefault? }`) from the `AgentRegistry`,
  so a frontend picker can source personas from the backend instead of hardcoding
  them. `@Agent({ description })` is now also carried through discovery onto the
  `AgentDefinition` (it was previously declared but dropped). `ActorResolver` is
  made generic over the request type (`ActorResolver<TReq = unknown>`) so hosts
  can implement it against their concrete request without an `unknown`-narrowing
  guard; the default type parameter keeps every existing call site source-compatible.
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
