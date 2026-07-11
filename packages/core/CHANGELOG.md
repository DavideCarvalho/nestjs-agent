# @dudousxd/nestjs-agent-core

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
