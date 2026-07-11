# @dudousxd/nestjs-agent-testing

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
