# @dudousxd/nestjs-agent-store-mikro-orm

## 1.0.0

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
