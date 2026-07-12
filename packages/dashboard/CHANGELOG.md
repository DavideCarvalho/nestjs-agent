# @dudousxd/nestjs-agent-dashboard

## 0.7.0

### Minor Changes

- [`71b8d42`](https://github.com/DavideCarvalho/nestjs-agent/commit/71b8d42d211d28516929298c44e6868d8925cc02) - Live-testing fixes from the first dispatched-steps consumer:

  - **CRITICAL — durable turns on the BullMQ thin worker no longer corrupt their history.** The
    workflow's control-flow classification used `instanceof WorkflowSuspended`, but the thin worker's
    suspends throw `@dudousxd/durable-worker`'s `Suspend` — a different class — so every dispatched
    llm step's suspend was misclassified as a real failure: the failure path ran DURING the suspend,
    emitted extra checkpoints, and the resumed replay died with NondeterminismError ("Something went
    wrong: workflow suspended" on every turn). All three classification sites (workflow catch, the
    loop's `isControlFlowError` hook, the runner's start-suspend swallow) now use durable-core
    0.52.0's marker-based `isWorkflowControlFlowSignal` — the peer floor rises to
    `@dudousxd/nestjs-durable-core >= 0.52.0` accordingly.
  - **Dashboard mounted in an Inertia host:** an Inertia `<Link>` visit to the console received plain
    HTML and rendered it inside the client's about:srcdoc error modal, where relative assets die on
    CORS. The UI controller now answers `X-Inertia` requests with the protocol's own external-redirect
    mechanism (`409` + `X-Inertia-Location`), so in-app links full-load the console correctly.
  - **Approvals attribution defaults to the AgentModule-configured actor resolver** (`@Global`,
    already exported) — zero config for hosts whose console auth matches chat auth; the
    `approvalActorRef` override is now generically typed (`AgentDashboardOptions<TReq>`, mirroring
    `ActorResolver<TReq>`) for hosts where it differs.

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

## 0.5.0

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

## 0.4.1

### Patch Changes

- [#5](https://github.com/DavideCarvalho/nestjs-agent/pull/5) [`619a097`](https://github.com/DavideCarvalho/nestjs-agent/commit/619a09771830db31739594813b0b937b844939f6) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Guards with dependencies now resolve: guard classes and the host's `imports` are threaded into
  `AgentApiModule` (the API controller's HOST module) and registered as providers on both host
  modules — enhancers DI-instantiate from their controller's own module, never a parent, so the
  previous wiring failed boot with "Nest can't resolve dependencies ... in the AgentApiModule
  context" for any guard that injects something.

## 0.4.0

### Minor Changes

- [#3](https://github.com/DavideCarvalho/nestjs-agent/pull/3) [`abb32bc`](https://github.com/DavideCarvalho/nestjs-agent/commit/abb32bc0396c65a59ee2b92a1a8b07d772215e31) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `AgentDashboardModule.forRoot()` gains a first-class `guards` option (`Type<CanActivate>[]`, stamped
  on both the SPA and API controllers via `@nestjs/common`'s own `@UseGuards` metadata — REPLACE
  semantics) plus an `imports` passthrough for the guards' own dependencies, replacing the "front the
  routes with your own guard" doc note with a real mechanism. A new `agentDashboardMountPaths()` helper
  returns the four route roots (UI + API, each with a `{*splat}`) a host's `setGlobalPrefix('api',
{ exclude })` needs to keep the dashboard resolving outside the prefix — mirrors
  `telescopeMountPaths()`.

  Every actor-scoped API row (`spend().byActor`, `GET top-threads`, `GET threads`) now carries an
  additive `actorLabel: string | null`, resolved via the optionally-injected `AGENT_ACTOR_DIRECTORY`
  (batched into one `resolveDisplay()` call per response) — `null` on every row when nothing is bound,
  so existing consumers keep working unchanged. `ActorsSection` renders the label when present.

  The dashboard API gains pricing CRUD backed by the optionally-injected `AGENT_PRICING_STORE`:
  `GET <api>/pricing` (list current prices) and `POST <api>/pricing` (upsert a model's price, minimally
  validated), both 501ing with a clear message when no pricing store is bound. A new "Pricing" tab in
  the SPA lists current rates and offers a minimal upsert form, replacing the hand-written pricing
  controller + curation UI consumers otherwise maintain themselves.

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
