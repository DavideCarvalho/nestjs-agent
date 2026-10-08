# @dudousxd/nestjs-agent-testing

## 0.28.3

### Patch Changes

- [#338](https://github.com/DavideCarvalho/nestjs-agent/pull/338) [`6630829`](https://github.com/DavideCarvalho/nestjs-agent/commit/6630829df0f8ccc34310d7db125270d4984f12cd) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - An empty assistant message no longer poisons a thread. When the model ended a step with no text (Claude does this right after a tool whose result is the answer, such as `renderResult`), the loop stored an assistant message with empty content and replayed it on the next turn. Anthropic and Bedrock refuse the whole request for it ("The content field in the Message object at messages.N is empty"), so every later message on that thread failed.

  - The loop no longer stores a step that has no text and nothing else on it (no tool call, pushed UI, reasoning or follow-ups). A tool-call-only assistant message is still stored and replayed as before. The `persist:assistant:<step>` checkpoint stays (it records `null`), so runs in flight replay unchanged.
  - History building drops every assistant message whose text is empty or whitespace-only and that has no tool calls or results, so a thread that already stored one heals on its next turn.
  - `aiSdkModel` never sends an empty assistant message or a whitespace-only text part next to tool calls.
  - The follow-up prompt and a detached run's delivery skip a blank answer too.
  - `@dudousxd/nestjs-agent-testing` exports `BLANK_ASSISTANT_HISTORY_CONTRACT`, run by both SQL stores' real-database suites.

## 0.28.2

### Patch Changes

- [#336](https://github.com/DavideCarvalho/nestjs-agent/pull/336) [`80630c6`](https://github.com/DavideCarvalho/nestjs-agent/commit/80630c660568a6d57c68effc50abdf85a1da8501) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - An independent proposal's tool-call record follows the proposal. In `actionApprovalMode: 'independent'` the turn records the call as `proposed` and ends; approving, executing, rejecting, expiring or superseding the proposal only changed the proposal row, so the dashboard (and anything reading `agent_tool_call`) showed an executed action as PROPOSED forever. Every store (in-memory, MikroORM, Drizzle) now settles the call on each proposal transition, in the same write path: `executed` with the output, `failed` with the error, `rejected`, or `expired` (lapsed, or superseded by a newer proposal). New in core: `toolCallUpdateForProposal` / `toolCallUpdateForTransition`; in testing: `PROPOSED_TOOL_CALL_CONTRACT`. The Drizzle read-model accepts the `proposed` status filter, and the dashboard shows `proposed` as live.

## 0.28.1

### Patch Changes

- [#334](https://github.com/DavideCarvalho/nestjs-agent/pull/334) [`141715c`](https://github.com/DavideCarvalho/nestjs-agent/commit/141715cbba01263f28719edce62829a6b75d75d0) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fixes ported from the AdonisJS sibling's frontends comparison:

  - **Hidden tools no longer run.** A tool whose `describe()` answers `available: false` for the turn (a genui `ui__render` or `ui__show_*` tool that `uiCapabilities` rule out) was left out of the tools offered to the model, but still ran when the model called it anyway. `ToolRegistry.invoke` (and `prepare`) now ask `describe()` again with the call's actor, thread, agent and `uiCapabilities`, and refuse the call as an unknown tool (`ToolNotFoundError`). The other offer filters (allow-list, `isEnabled`, roles, `canUse`) were already checked again on invoke.
  - **No 501 from the proposals list where there can be none.** `GET <base>/threads/:id/action-proposals` answered `501` on a store without the proposal capability (one that can only run blocking approvals), and `AgentService.listActionProposals` threw `404` in blocking mode. Both answer an empty list now. `useAgentChat` reads that list by default, so every chat on such a store logged a failed request unless it passed `proposals: false`. Approving or rejecting a proposal still refuses.
  - **AG-UI approval interrupt wording.** The `tool_approval` interrupt's `message` is now the tool's `confirmation.title` when the call has one, the same wording the `agora.approval-requested` event carries. Before, it was always `Approve <tool>?`.
  - **`FakeModelProvider` tool call ids are unique.** Ids were `call-<turnIndex>-<name>`, so the same tool on the same turn of two threads got the same id; a tool call id is the store's primary key across threads. The first call still gets `call-<turnIndex>-<name>`. A repeat from the same provider instance gets the first free `-2`, `-3`… suffix.
  - **A Stop aborts what the run is in.** Under the inline runner, cancelling a run aborts the in-flight model call (`ModelTurnArgs.abortSignal`, which `aiSdkModel` passes to the AI SDK) and hands tools the signal as the new `AiToolCtx.abortSignal`. Before, the model kept streaming to the end of the step. The run still ends `cancelled`, and the step the Stop cut short is not persisted. Custom runners can pass a signal through the new `AgentLoopHooks.abortSignal`. The durable runner is unchanged.

## 0.28.0

### Minor Changes

- [#326](https://github.com/DavideCarvalho/nestjs-agent/pull/326) [`a4a098c`](https://github.com/DavideCarvalho/nestjs-agent/commit/a4a098c61b3246bce716a124b3fa3372b1af6cf5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Text channels — WhatsApp (Evolution API, Cloud API) and Telegram (port of adonis-agora-agent#313).

  New package `@dudousxd/nestjs-agent-channels`: `AgentChannelsModule.forRoot({ channels: [{ adapter, actor, thread, onThreadCreated?, pageContext?, … }], store?, path? })` (or `forRootAsync`) mounts `/channels/<name>` (and `/channels/<name>/:token`) for every channel. Each webhook is verified (`401` otherwise; WhatsApp Cloud's `GET hub.challenge` answered), deduplicated by the provider's message id, acknowledged with `200` at once and answered in the background (`AgentChannelsService.drain()`; drained on module destroy). The turn is sent with text-only capabilities and `pageContext.channel = { name, conversation }`; text decisions get their reply; the reply (prose and component `fallbackText`) is converted to the channel's markdown (`toChannelMarkdown`: WhatsApp, Telegram MarkdownV2, none) and split at its length limit (`splitMessage`). Media is downloaded within the attachment limits, staged with `AgentService.stageAttachment` and attached as `{ mediaId }` — or refused with `texts.mediaRefused`. Questions (`ask`, intakes) go out as numbered text one at a time; the next messages answer them (`parseChannelAnswer`, `skip`), and `questionTimeoutMs` skips them. Pending proposals get Confirm/Cancel buttons (`agora:approve|reject:<last 32 of the id>`) decided through `AgentService.decideActionProposal` with `via` = the channel's name, or a text instruction in the configured `actionProposalText` vocabulary; an approved proposal's outcome is relayed after `outcomeTimeoutMs`, and later ones through the worker's settled hook, each once. Adapters: `evolutionApi`, `whatsappCloud` (`X-Hub-Signature-256` over the raw body — create the app with `rawBody: true`), `telegram`; any `ChannelAdapter` works. `path: false` + `AgentChannelsService.handle(name, req, res)` serve the webhook from a controller of your own.

  - core: the `ChannelStore` SPI (`claim` / `get` / `set` / `delete` with TTLs, optional `purgeExpired`), `InMemoryChannelStore`, and the `AGENT_CHANNEL_STORE` token.
  - nestjs: `AgentService.actionApprovalMode()`, `actionProposalVocabulary()`, `actionProposalReply(result, decision)`, `listActionProposals(actor, threadId)`, `attachmentLimits()` and `stageAttachment(actor, file)` (the upload route's checks: `501` / `415` / `413`); `ActionProposalWorkerService.onSettled(listener)` and `actionProposalWorker.onSettled` run after each proposal the worker settles; `ActionProposalService.textVocabulary()`.
  - store-drizzle, store-mikro-orm: `DrizzleChannelStore` / `MikroOrmChannelStore` on a new `agent_channel_state` table (created by `ensureAgentSchema`; MikroORM: also in `agentEntities()` / `agentManagedTables()`), bound to `AGENT_CHANNEL_STORE` by the store modules — the channels' default store when present.
  - transport-redis: `RedisChannelStore` (`SET … PX … NX`), taking an `ioredis` client as is.
  - testing: `CHANNEL_STORE_CONTRACT`, the cases every channel store runs.

## 0.27.0

### Minor Changes

- [#323](https://github.com/DavideCarvalho/nestjs-agent/pull/323) [`52703f0`](https://github.com/DavideCarvalho/nestjs-agent/commit/52703f077f5ae22ade28fbb5838d6591abcadc6e) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `hostContext`: the host's own JSON facts about a send (where it came from, where its answer goes) travel on `AgentRunInput` through `AgentService.chat`, the queue (persisted by the in-memory, Drizzle and MikroORM stores; never on the wire view) and the durable journal. The OpenCode engine's host gets lifecycle hooks: `onAsk`, `onUi`, `beforeSettle` (append components, word a failure) and `onSettled` (deliver, record spend), each seeing the run's `hostContext`. `CreateThreadInput.agentName` lets a store start a thread on the send's agent; `AgentRunner.runIdFor` lets a runner name its runs (the OpenCode engine's `runId` setting); `openCodeDurable({ durable: { start, startError } })` sets each turn's workflow start options (tags, search attributes, concurrency quota) and maps a refused start. The host also gets `startOptions`/`startError` (durable starts from DI), `promptFor` (what the session is prompted with), `reuse` (keep the thread's session or open a new one) and `beforePrompt` (update the session every turn: model, permissions, tools). `ChatParams.authorized` lets a host send into a thread it already decided the actor may write (a shared channel thread); the OpenCode engine adds `pushToSession` (trusted pushes) and `liveRuns()`. Engine tokens are `Symbol.for` (shared by the main and `/durable` bundles) and `OPENCODE_TURNS` resolves the engine's turn steps from outside — inject it, not the class.

## 0.26.1

### Patch Changes

- [#319](https://github.com/DavideCarvalho/nestjs-agent/pull/319) [`6b7de84`](https://github.com/DavideCarvalho/nestjs-agent/commit/6b7de84eca7dd094baf21a19be8144d8ae2409da) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `FakeModelProvider` now writes its scripted text to the sink as a `text` stream event (`encodeStreamEvent({ kind: 'text', text })`), the same frame `aiSdkModel` writes. Before, it wrote raw bytes, which a client such as `@dudousxd/nestjs-agent-react` couldn't decode, so a UI running against the fake showed no live text.

## 0.26.0

### Minor Changes

- [#284](https://github.com/DavideCarvalho/nestjs-agent/pull/284) [`cb8b15a`](https://github.com/DavideCarvalho/nestjs-agent/commit/cb8b15aa26bd5d7f68af40d41b4ddeba3d9b71dd) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add the optional ActionProposalStore capability with scoped replay-safe snapshots, atomic decisions and queued execution work, and fenced recoverable leases in memory, Drizzle and MikroORM. This is the persistence foundation; independent conversation execution is not enabled yet.

- [#287](https://github.com/DavideCarvalho/nestjs-agent/pull/287) [`b233a41`](https://github.com/DavideCarvalho/nestjs-agent/commit/b233a418b411215e03e8bb02c32e13d685089f53) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add indexed worker-only proposal discovery to SQL stores: claim queued or expired-lease work across
  scopes and expire due pending cards in bounded batches. Every proposal mutation keeps discovery
  metadata in the same fenced write. Add a shared worker-store conformance contract and bounded,
  version-fenced backfill for existing proposals after additive schema migration.

  Stop old writers before applying the migration and repeating backfill batches, then start the new
  workers. This capability does not itself enable the independent conversation runtime.

- [#288](https://github.com/DavideCarvalho/nestjs-agent/pull/288) [`db48ea8`](https://github.com/DavideCarvalho/nestjs-agent/commit/db48ea8a7c281a111f4079a8e4ba9036244068c5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add opt-in independent action approvals: pending cards release the chat turn, scoped channel/text
  decisions queue work under fresh requester authorization, pending replacement is atomic, and
  fenced workers admit terminal result facts/UI into history without a model continuation.
  Remembered approvals derive from terminal proposal state. Preserve blocking durable journals.

  Negotiate the authorized component catalog against client renderer capabilities across native
  HTTP, queued turns and AG-UI; persist complete text fallbacks for unsupported and historical UI.
  SQL adapters add runtime metadata/indexes and atomic delivery on their transaction authority.
  Apply additive schema upgrades before enabling workers; external effects remain at least once
  and require the stable tool-context idempotency key. See docs/independent-approvals.md.

### Patch Changes

- [#285](https://github.com/DavideCarvalho/nestjs-agent/pull/285) [`133975e`](https://github.com/DavideCarvalho/nestjs-agent/commit/133975e7b9aa9da44f708ce4a95940fb6f6440e4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add opt-in trusted preparation for independent action proposals. Preserve original JSON separately
  from the approved normalized input and immutable execution context, and reject schema or hook
  input drift before effects. Existing blocking preparation and invocation retain their behavior.
  Expose privileged worker discovery with a reference implementation in memory; SQL discovery and
  the independent conversation runtime are separate follow-up work.

## 0.25.1

### Patch Changes

- [#277](https://github.com/DavideCarvalho/nestjs-agent/pull/277) [`aabc27e`](https://github.com/DavideCarvalho/nestjs-agent/commit/aabc27e544beda62c5b28849effa00edaa93608d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `CHAT_QUEUE_STORE_CONTRACT` compares the JSON a store hands back (actor, attachments, page context,
  queue pause) as values, not as serialized strings. Postgres `jsonb` and MySQL `JSON` return object
  keys in their own order, so a store on either failed the contract while round-tripping every field.

## 0.25.0

### Minor Changes

- [#274](https://github.com/DavideCarvalho/nestjs-agent/pull/274) [`86afcb7`](https://github.com/DavideCarvalho/nestjs-agent/commit/86afcb75e11f4b676439c215885371c706389ab2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Personas: named variants of ONE agent — their own prompt and, optionally, a narrower tool
  allow-list — ported from `@adonis-agora/agent`, on the same wire.

  - `@Agent({ personas: [{ id, label, description?, systemPrompt?, allowedTools?, aliases? }], defaultPersona })`.
    A flat persona prompt stands in for the agent's base prompt; a builder gets it as `ctx.basePrompt`.
    `PromptContext.persona` lets the agent's own `@SystemPrompt()` branch on it (DI-friendly).
  - `POST <base>/chat { persona }` (AG-UI `forwardedProps.persona`, `AgentService.send({ personaId })`):
    send > thread pin > `defaultPersona` > none; a named persona is pinned on the thread
    (`ThreadSummary.persona`, `PATCH threads/:id { persona }`); `400 persona_not_found` otherwise.
  - `allowedTools` narrows the offered list AND `ToolRegistry.invoke` (new `InvokeOptions.allowedTools`)
    and handoffs, after the agent allow-list, `enabled`, roles and `canUse`. Tools get `ctx.persona`.
  - Durable-safe: the persona's id rides `AgentRunInput.persona` (and a queued message's `persona`); its
    definition is frozen once in a `persona:resolve` checkpoint that only a run naming one spends, so a
    parked run resumes on the persona it started with and runs from before the upgrade replay unchanged.
  - `Persona.aliases` lets a persona answer for the agent name it replaced (sends, thread
    `defaultAgent`, queued messages, in-flight durable runs) — no data migration.
  - `GET <base>/agents` lists each agent's `personas` and `defaultPersona`. Every message records
    `persona`.
  - React: `useAgentChat({ persona })` + `threadPersona`, `useAgents().personasOf()/defaultPersonaOf()`,
    `persona`/`agentName` on transcript message metadata, `ThreadPatch.persona`.
  - Stores: nullable `persona` on `agent_thread`, `agent_message` and `agent_queued_message`, added by
    `ensureAgentSchema` on both adapters (Drizzle's additive pass, MikroORM's safe update); hosts on
    their own migrations add the three columns. `personaForThread` projection on every adapter.

  - Codegen: `persona` on messages, thread summaries, queued messages and the thread PATCH body;
    `personas`/`defaultPersona` on the agents catalog entry.

  No `personas` → nothing changes.

## 0.24.0

### Minor Changes

- [#269](https://github.com/DavideCarvalho/nestjs-agent/pull/269) [`2e3ae25`](https://github.com/DavideCarvalho/nestjs-agent/commit/2e3ae254d33123ee589008a1711d10c7b7c3f0ee) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A `TokenStreamSink` over SQL — several replicas without Redis (port of adonis-agora-agent#234).

  ```ts
  AgentModule.forRoot({ model, sink: new DrizzleTokenStreamSink(db) });
  // or: useFactory: (em: EntityManager) => ({ model, sink: new MikroOrmTokenStreamSink(em) })
  ```

  One row per frame in `agent_stream_frame`, numbered per run with no gaps (`MAX(seq) + 1` in the insert; the `(run_id, seq)` key turns a race into a retry); any replica serves and resumes the SSE by polling. Consecutive `text` frames are coalesced at write time (`flushMs`, 50 ms), so every replica reads the same rows and `?after=` cursors stay exact. TTL counts from the run's last write (`ttlSeconds`, 1 h); `purgeExpired()` runs on its own after a run ends. A run that `fail()`s ends with a terminal row carrying the error. Polling only.

  - core: `SqlTokenStreamSink` (the logic) over a `StreamFrameTable` (the SQL), and `SinkWriter.flush?()` — write out what a writer holds back without ending the stream.
  - nestjs: `childSinkWriter` flushes on `end` / `fail`, so a delegated run's gathered text lands before its parent's next frame.
  - store-drizzle / store-mikro-orm: `DrizzleTokenStreamSink` / `MikroOrmTokenStreamSink` and the `agent_stream_frame` table (`ensureAgentSchema`; MikroORM: also in `agentEntities()` / `agentManagedTables()`).
  - testing: `SQL_TOKEN_STREAM_SINK_CONTRACT` and `InMemoryStreamFrameTable`.

## 0.23.0

### Minor Changes

- [#267](https://github.com/DavideCarvalho/nestjs-agent/pull/267) [`43fa891`](https://github.com/DavideCarvalho/nestjs-agent/commit/43fa891a5a48bcf2130d01c4952b7b767d5dd502) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Confirmed writes — preview, signed single-use `confirmToken`, commit (port of adonis-agora-agent#233).

  `defineConfirmedTool(options, { prepare, preview, commit })` returns a functional tool whose human gate lives inside it, so the same write serves the chat loop and MCP (where an `action` tool has no approval channel): a call without `confirm` validates and previews without writing and returns a `confirmToken`; the same arguments plus `confirm: true` and the token commit. The token is an HMAC over the tool, actor, tenant, expiry and canonical arguments. A `ConfirmTokenStore` makes it single use — claimed right before `commit`, released if `commit` throws.

  - core: `defineConfirmedTool`, `withConfirmFields`, `ConfirmTokenError`, `signConfirmToken` / `verifyConfirmToken` / `hashConfirmToken` / `canonicalJson`, the `ConfirmTokenStore` SPI, `InMemoryConfirmTokenStore`, `AGENT_CONFIRM_TOKEN_STORE`, and `SchemaExtension` / `schemaExtensionOf` (a schema that is another schema plus a few JSON properties).
  - ai-sdk, mcp-server: a `SchemaExtension` schema is converted through its inner schema, so a Zod 3 tool wrapped by `withConfirmFields` shows the model its real shape plus `confirm` / `confirmToken`.
  - store-drizzle, store-mikro-orm: `DrizzleConfirmTokenStore` / `MikroOrmConfirmTokenStore` on a new `agent_confirm_token` table (created by `ensureAgentSchema`; MikroORM: also in `agentEntities()` / `agentManagedTables()`), bound to `AGENT_CONFIRM_TOKEN_STORE` by the store modules.
  - testing: `CONFIRM_TOKEN_STORE_CONTRACT`, the cases every store runs.

## 0.22.0

### Minor Changes

- [#244](https://github.com/DavideCarvalho/nestjs-agent/pull/244) [`6cfebc7`](https://github.com/DavideCarvalho/nestjs-agent/commit/6cfebc785e9d0350864dedcba3a15ec928dd28b1) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Message queue: a per-call mode, interrupting with a message that is already waiting, and queued
  files in the shape sent files have.

  - **`composer.submit({ mode })` / `sendMessage(message, { mode })`** (react) — `'queue'` or
    `'interrupt'` for that one send, overriding the chat's `whileRunning` (`'block'` included). What a
    "send now" button next to a plain send needs; the composer clears its own draft and files, so a
    host no longer calls `chat.queue.add` and resets the draft by hand. With nothing running, `mode`
    means nothing and the message is simply sent (it never reaches the request).
  - **`chat.queue.interrupt(id)`** (react) and **`POST <base>/queue/:messageId/interrupt`** (nestjs,
    `AgentService.interruptQueuedMessage`, `AgentBackend.interruptQueuedMessage?`,
    `AgentClient.interruptQueuedMessage`, codegen `queue.interrupt`) — run a waiting message now: it
    moves to the head marked as an interrupt, any pause is lifted, and the running turn is cancelled
    for it, in one request. It answers the queue plus `interrupting` (the cancelled run), or `runId`
    when nothing was running and the message started. The message keeps its id and never leaves the
    queue — a `remove` followed by an `add` loses it when the second call fails and runs it twice when
    another tab's drain gets there first. Documented in docs/stream-protocol.md (_Interrupting with a
    message that is already waiting_); optional for a backend of your own.
  - **`QueuedMessagePatch.interrupt`** (core) — `ChatQueueStore.updateQueuedMessage` may now mark or
    unmark a waiting message as an interrupt. `InMemoryAgentStore`, the Drizzle store and the MikroORM
    store store it (the column already existed), and `CHAT_QUEUE_STORE_CONTRACT` has a case for it. A
    store of your own that ignores the key keeps working for everything else; the new route answers
    `501` on it rather than cancel a turn for a message that would then not start.
  - **`TranscriptQueuedItem.files` / `QueuedChatMessage.files`** (react) — a waiting message's files
    are `MessageFile`s (`kind`, `extension`, `mediaId`, as `messageFiles()` gives for a sent message);
    the transcript's also keep `isImage`, so both the `MessageFile` and the `TranscriptFile` renderer
    take them. New export `attachmentFile(attachment)`. Type note: `QueuedChatMessage.files` and
    `ChatQueue.interrupt` are required members — code that builds those objects by hand (a test
    double, mostly) adds them; `useChatTranscript({ queue })` still takes items without `files`.

## 0.21.0

### Minor Changes

- [#241](https://github.com/DavideCarvalho/nestjs-agent/pull/241) [`68aee17`](https://github.com/DavideCarvalho/nestjs-agent/commit/68aee1787ea8a63279859ed99376849e1e8937b1) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Send while the agent is still answering: the message queue.

  - **Server.** `POST <base>/chat` on a thread with a turn running queues the message on the thread (persisted, per-thread FIFO) and answers `202 { queued: true, messageId, position, queue }` instead of starting a second, concurrent turn. When the turn settles the next queued message starts under its own id (inline and durable runners — the durable drain is journaled and spawned with `ctx.startChild`, so it never starts twice), announced as a final `queue` frame (`started: { messageId, runId }`) before the terminal. `mode: 'interrupt'` cancels the running turn and runs the message next; `mode: 'queue'` always queues. A failed turn or a Stop pauses the queue; an exhausted quota pauses it as the next message starts. New routes: `GET`/`DELETE threads/:id/queue`, `POST threads/:id/queue/resume`, `PATCH`/`DELETE queue/:messageId`; `GET threads/:id` carries `queue`. Admission is now a compare-and-set on the thread's active run (one turn per thread across pods; a stale holder left by a crashed process is replaced). `AgentService.send()` queues; `AgentService.chat()` stays start-or-refuse for in-process callers (`409 run_active` on a busy thread); `regenerate` on a busy thread is `409`.
  - **Core.** `ChatQueueStore` (probed by `isChatQueueStore`), `QueuedMessage`/`ChatQueueState`/`QueuePause`, the `queue` stream event, `ThreadDetail.queue`, `AgentRunner.start(input, { runId })` and the optional `isRunActive`. `InMemoryAgentStore` implements the queue.
  - **Stores.** Drizzle and MikroORM add `agent_queued_message` and `agent_thread.queue_pause` on boot (MikroORM: in `agentManagedTables()`); both implement `ChatQueueStore`.
  - **Testing.** `CHAT_QUEUE_STORE_CONTRACT` — framework-agnostic cases any `ChatQueueStore` can run.
  - **React.** `composer.submit()` / `sendMessage` mid-turn queue instead of being refused; `useAgentChat({ whileRunning: 'queue' | 'interrupt' | 'block' })`; `chat.queue` (`items`, `paused`, `add`, `remove`, `edit`, `move`, `clear`, `resume`, `error`); `chat.transcript.queued` renders waiting messages as pending user messages; the chat attaches to a queued turn when it starts, and starts a queue left waiting when the thread loads. `AgentBackend` gains the optional `enqueueMessage`, `getQueue`, `updateQueuedMessage`, `removeQueuedMessage`, `clearQueue`, `resumeQueue`; a `202` from `openChatStream` is reported as `queued`.
  - **Codegen.** The five queue routes, and `queue` on the thread detail.

## 0.20.0

### Minor Changes

- [#227](https://github.com/DavideCarvalho/nestjs-agent/pull/227) [`cd2c790`](https://github.com/DavideCarvalho/nestjs-agent/commit/cd2c7909df1c88cc914ec6aa28940800e0dcd705) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Zero-config server: `AgentModule.forRoot({ model })` is the whole setup.

  - **Store**: omit `store` and `AgentModule` uses the `AGENT_STORE` another module binds (a store module — found by scanning the container, whatever the import order), else the built-in in-memory store with a boot warning that it is not for production. `InMemoryAgentStore` moves into `@dudousxd/nestjs-agent-core` (the `-testing` package re-exports it).
  - **Identity**: `actorResolver` is optional. Without one the endpoints are public and every browser is its own anonymous actor — `AnonymousActorResolver`: a random token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` over HTTPS), the actor id `anon:<sha256 digest>` of it — so visitors never share threads, quota or attachments. A boot notice says the endpoints are public. `requestUserActorResolver(map?)` requires login in one line, reading `req.user` (Passport / cookie-session apps), `401` without it.
  - **Tools**: `@AiTool` `kind` defaults to `'read'` and `name` to the class name camelCased minus `Tool` (`GetWeatherTool` → `getWeather`); only `description` and `input` are required.
  - **Prompt**: module-level `systemPrompt` (string, or `(ctx) => string`) for the default agent and any `@Agent` without its own.
  - **Models**: `aiSdkModels({ id: model | { model, label, badges, … } }, { default })` from `@dudousxd/nestjs-agent-ai-sdk` returns a provider carrying `.catalog`, which `AgentModule` lists when `models` is omitted.

  **Breaking**

  - Tools no longer default to `['ADMIN']`: `DefaultRolesPolicy`'s default `defaultRoles` is `[]`, which restricts nobody — any resolved actor (anonymous included) can call a tool that names no `roles`. Explicit `@AiTool({ roles })`, `defaultRoles` and `rolesPolicy` still restrict. `action` tools still park on approval (by default the requester approves — for an anonymous visitor a confirmation, not an authorization). To keep the old behaviour: `AgentModule.forRoot({ defaultRoles: ['ADMIN'] })` (and `new AuthzRolesPolicy(gate, { fallbackRoles: ['ADMIN'] })`, whose fallback follows the same default).
  - `AgentModuleAsyncOptions.externalStore` is removed — a store module's `AGENT_STORE` is found automatically. `AGENT_STORE` is now always bound (and exported) by `AgentModule`.
  - `aiSdkModel`'s `resolveModel` option is removed, and a turn that picks a model the provider does not serve now fails instead of silently running on the bound model (a gateway id is no longer swapped for the pick). Use `aiSdkModels({ … })` for several models.
  - `@dudousxd/nestjs-agent-testing` requires `@dudousxd/nestjs-agent-core` `>=0.27.0`.

## 0.19.0

### Minor Changes

- [#215](https://github.com/DavideCarvalho/nestjs-agent/pull/215) [`104c3a6`](https://github.com/DavideCarvalho/nestjs-agent/commit/104c3a6a0cc0cbf2d6b101fb648daa2565e1b856) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Quota v2: budget windows, a pluggable QuotaProvider, and a send gate.

  - core: `QuotaProvider` SPI (`report({ actor, now? }) → { windows: [{ period: 'day' | 'month', usedTokens, limitTokens?, usedUsd, limitUsd?, resetsAt? }], blocked?: { period, reason? } }`), `AGENT_QUOTA_PROVIDER`, `exhaustedWindow`, `quotaPeriodRange`. Optional `AgentStore.usageBetween(actorRef, fromDay, toDay)`.
  - nestjs: `GET quota` answers the report. `LedgerQuotaProvider` (the default) reads the usage ledger — a day window (ceiling from the bound `QuotaStore`), plus a month window when the store has `usageBetween`. `AgentModule.forRoot({ quotaProvider })` binds your own (an AI-gateway budget); `quotaLimits: { day?, month? }` (tokens and/or USD) adds ceilings to the default. Either one turns on the send gate: a `blocked` report refuses `POST chat` with `429 { code: 'quota_exceeded', period, message }` before the turn starts. `GET quota/today` is unchanged.
  - stores / testing: `usageBetween` (and `quotaToday` delegates to it).
  - react: headless `useQuota({ backend, pollMs? })` (windows, `day`, `month`, `blocked`; re-read after every run a chat on the same backend settles); `AgentBackend.getQuota?` / `AgentClient.getQuota()`; `useAgentChat({ blocked })` refuses `sendMessage`/`regenerate` with `QuotaBlockedError` while a window is exhausted.
  - codegen: `GET /agent/quota` as `agent.quota.report`; `GET /agent/quota/today`'s response type now matches what it returns.

## 0.18.0

### Minor Changes

- [#213](https://github.com/DavideCarvalho/nestjs-agent/pull/213) [`a4dc582`](https://github.com/DavideCarvalho/nestjs-agent/commit/a4dc5823eea59e971404a53b4d7ce0fc7cda88b6) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Model catalog, per-thread and per-send model selection, model/agent picker hooks.

  - core: `ModelCatalog` SPI (`list({ actor, agent }) → { providers: [{ id, label, models: [{ id, label, description?, badges?, available, unavailableReason?, contextWindow? }] }], default }`), `staticModelCatalog`, `findCatalogModel`, `withSelectedModel`, `AGENT_MODEL_CATALOG`. `ModelTurnArgs.model`, `AgentRunInput.model`, `LlmStepEnvelope.model`, `ThreadSummary.model`, `UpdateThreadInput.model`. A turn with a selected model runs every call (answer, structured output, follow-ups, dispatched steps) on it and labels usage with it when the provider reports no model id.
  - nestjs: `AgentModule.forRoot({ models })`; `GET models?agent=` (`ModelsController`; empty catalog when none is bound); `POST chat { model }`; `PATCH threads/:id { model }` (`null` unpins). A model is refused with 400 unless the catalog lists it as available for the actor and agent — checked when pinned and again on every turn. Thread reads normalize `model` to `null`.
  - ai-sdk: `aiSdkModel(model, { resolveModel })` runs the picked id; without a resolver a gateway string id is swapped for the pick and a provider instance ignores it.
  - store-drizzle / store-mikro-orm / testing: `agent_thread.model` (nullable, added by `ensureAgentSchema`, copied on fork), `modelForThread`.
  - react: `useModels({ backend, agent })` (grouped + flattened options, `find`, `defaultModel`), `useAgents({ backend })`; `AgentBackend.listModels?` / `listAgents?` (and `AgentClient` methods); `useAgentChat({ model })` sends it with every turn; `chat.setThreadModel(id | null)`; `ThreadPatch.model`.
  - codegen: `GET /agent/models` as `agent.models.list`; thread summaries carry `defaultAgent`/`activeRunId`/`model`; the thread PATCH body takes `title?`/`defaultAgent?`/`model?`.

## 0.17.0

### Minor Changes

- [#211](https://github.com/DavideCarvalho/nestjs-agent/pull/211) [`75eb415`](https://github.com/DavideCarvalho/nestjs-agent/commit/75eb415c98cde1ba3fdd8d0366774c5d7514bfdf) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Pluggable chat backend, resumable streams, message feedback and a thread-list hook.

  - react: `AgentBackend` — the interface every hook talks to (stream start/resume, cancel, thread CRUD required; fork/promote/truncate, approvals, answers, upload, tools, skills, quota, feedback optional). `AgentClient` implements it (new `openChatStream`, `resumeChatStream`, `setMessageFeedback`); `useAgentChat({ backend })` and `AgentChatTransport({ backend })` accept your own (a generated client, cookie session + CSRF). `useAgentChat` is generic over the backend and returns it as `backend` (and `client`), plus `getThreadId()` and `connection`. A missing optional member throws `AgentBackendUnsupportedError`.
  - react: the transport reconnects a dropped, numbered stream from its last frame (`?after=<seq>`) with exponential backoff (`reconnect: { maxAttempts, baseDelayMs, maxDelayMs } | false`); `status` reads `'reconnecting'` meanwhile (`ChatStatus` gains it; the transcript treats it as streaming). A run that ended while away reloads the thread.
  - react: headless `useThreads({ backend })` (list, optimistic rename/remove, refreshed when a chat on the same backend creates a thread, settles a run or streams a title) and `useMessageFeedback({ backend, threadId })`. Live messages carry `metadata.runId`; replayed ones `metadata.feedback` (`AgentMessageMetadata`). `useToolCatalog`/`createSkillsSource` accept any backend with `listTools`/`listSkills`.
  - nestjs: every event frame carries an SSE `id:` (1-based, stable across attaches); `GET chat/:runId/stream` honours `?after=` and `Last-Event-ID`. New `POST messages/:id/feedback` (`MessagesController`, `AgentService.setMessageFeedback`).
  - core: `StoredMessage.feedback`, `MessageFeedback`; optional `AgentStore.threadOfMessage` / `setMessageFeedback`.
  - store-drizzle / store-mikro-orm: `agent_message.feedback` (json, nullable; added by `ensureAgentSchema`, not copied on fork). testing: `InMemoryAgentStore` implements both.
  - codegen: `POST /agent/messages/:id/feedback` as `agent.messages.feedback`; `feedback` on stored messages.

## 0.16.0

### Minor Changes

- [#207](https://github.com/DavideCarvalho/nestjs-agent/pull/207) [`13b50e2`](https://github.com/DavideCarvalho/nestjs-agent/commit/13b50e24461194aec197e96b82bbee1afc4570c8) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `ctx.emitUi(component, props, { id?, version? })`: a tool pushes a generative-UI component. It
  streams live as a `ui` frame (inline, durable, and from the worker serving a dispatched tool step)
  and is persisted on the assistant message through the new optional `AgentStore.setMessageUi`
  (implemented by the Drizzle, MikroORM and in-memory stores), once per step. The pushes ride the tool
  step's journaled result, so a durable replay neither re-streams nor re-persists them; a tool that
  pushes nothing journals exactly what it did before. `ui` frames and persisted components gain an
  optional `toolCallId`, and a reloaded message places such a component right after its call's tool
  part (React: `TranscriptUiBlock.toolCallId`). `ToolSpec.terminal` / `@AiTool({ terminal: true })`
  ends the turn after a successful call, settled in the call's `persist:toolcall` checkpoint.

  `@dudousxd/nestjs-agent-genui` requires core >= 0.22, where its tools push through `ctx.emitUi` and
  `terminal` takes effect.

## 0.15.0

### Minor Changes

- [#203](https://github.com/DavideCarvalho/nestjs-agent/pull/203) [`26254d2`](https://github.com/DavideCarvalho/nestjs-agent/commit/26254d2020408e1712555d074a1814a9ba97b66c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Elicitation typed inputs.

  - core: `ElicitationQuestion` gains `description?` and `input?: { type: 'text' | 'textarea' | 'number' | 'boolean' | 'date' | 'email' | 'url' | 'select'; placeholder?; required?; min?; max?; pattern? }`. `options` is optional when `input` asks for a typed value, and a typed question may omit `defaults`. The `ask` tool accepts and describes them. Answers stay `string[]` in one canonical form per type. `validateElicitationValue` / `validateElicitationAnswer` / `readElicitationQuestions` are shared by the loop (which drops values it cannot settle), the server and the client. New optional store method `toolCallInput`.
  - nestjs: `POST tool-call/answer` checks answers against the parked questions and answers `400 answers["<id>"] <reason>` for a value a question refuses, or for a required question left without an answer or default.
  - stores: implement `toolCallInput`.
  - react: transcript questions carry `description`, `input`, `value`, `setValue(raw)` and `error`, and the block carries `isValid`. Headless `coerceAnswer(question, raw)` and `validateAnswer` are exported.

## 0.14.0

### Minor Changes

- [#201](https://github.com/DavideCarvalho/nestjs-agent/pull/201) [`b410e83`](https://github.com/DavideCarvalho/nestjs-agent/commit/b410e836782605c13103ea3782e4146cb07aeefd) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Approvals v2: who approves an action, for how long, and whether to ask again.

  - core: `ApprovalPolicy` SPI (`requirementFor(tool, actor, thread) → { required, approver, ttlMs? }`,
    optional `canDecide`), default = the requester with no expiry. Decided inside the call's
    `persist:toolcall` checkpoint together with the thread's remembered approvals, so replays read it
    back. `AgentLoopHooks.awaitApproval` gains `{ timeoutMs }`; a lapsed wait (`Decision.expired`)
    settles the call as the new `ToolCallStatus 'expired'`, told to the model as an expired approval.
    `Decision.remember` / `Decision.decidedVia`; new `approval-settled` stream frame;
    `StoredMessage.approvals`; optional store methods `rememberedApprovals` / `toolCallApproval`.
  - nestjs: `forRoot({ approvalPolicy })`; approve/reject enforce the recorded approver (403) and
    refuse a lapsed request (410), record the decider and `via`, accept `remember`. The durable runner
    passes the ttl to `ctx.waitForSignal(…, { timeoutMs })`, the inline runner arms a timer.
  - stores: `agent_tool_call` gains `approver`, `expires_at`, `remember`, `decided_via` (added by
    `ensureAgentSchema`), read back as `StoredMessage.approvals`.
  - react: `call.approval` gains `status`, `remember`, `decidedBy`, `decidedVia`, `decisionReason`;
    `call.approve.run({ remember: true })`; headless `useApprovalCountdown(expiresAt)`;
    `data-approval-settled` parts live and on reload.

## 0.13.0

### Minor Changes

- [#197](https://github.com/DavideCarvalho/nestjs-agent/pull/197) [`70a3766`](https://github.com/DavideCarvalho/nestjs-agent/commit/70a3766ffa662392394c28f3336146cc157b7f96) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Reasoning and pushed UI survive a reload.

  - core: `StoredMessage` / `AppendMessageInput` gain `reasoning?`, `reasoningMs?` and `ui?: AgentUiComponent[]`; `ModelTurnResult` gains the same three (optional). New `observeTurnFrames` / `withTurnFrames` derive them from the frames a provider streams (thinking time = sum of each burst of consecutive `reasoning` frames), inside the model checkpoint so replays read the journaled values. The loop persists them on each step's assistant message and adds `reasoningMs` to `step-finish`.
  - nestjs: the dispatched `llm` step derives them the same way, so they ride its journaled result.
  - store-drizzle: `agent_message.reasoning` / `reasoning_ms` / `ui` columns, added to existing databases by `ensureAgentSchema`'s additive pass (ALTERs in the README for drizzle-kit users); copied on fork.
  - store-mikro-orm: the same three entity properties (the safe schema update adds them); copied on fork.
  - testing: `InMemoryAgentStore` persists them; `EVERY_MESSAGE_FIELD` includes them, so adapter round-trip specs must cover them.
  - react: `storedMessageToUiMessage` emits a `reasoning` part before the text and `data-ui` parts for persisted components. The transport stamps `step-finish.reasoningMs` (or the time it watched, as a fallback) on the reasoning part's `providerMetadata.agent.reasoningMs`, and `TranscriptReasoningBlock.durationMs` reads it — the same value live and reloaded. New headless `useElapsed(running)`, `formatElapsed(ms)` and `readReasoningMs(part)`. The registry `ChatReasoning` derives its duration label from them when the host passes none.

## 0.12.0

### Minor Changes

- [#187](https://github.com/DavideCarvalho/nestjs-agent/pull/187) [`505702e`](https://github.com/DavideCarvalho/nestjs-agent/commit/505702e5df0b769d6cd78f76696c1bd569c11e68) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - New `openAiEmbeddings` (an `EmbeddingProvider` over any OpenAI-compatible `/v1/embeddings` — OpenAI, gateways, TEI, Ollama, vLLM) and `HttpReranker` (a `Reranker` over Cohere/Jina/Voyage/TEI-style `/rerank`), both dependency-free and throwing `HttpModelError`. `@dudousxd/nestjs-agent-testing` adds `hashedEmbeddings(dimensions)` and a `tokens: 'unicode'` option on `FakeEmbeddingProvider`.

## 0.11.0

### Minor Changes

- [#101](https://github.com/DavideCarvalho/nestjs-agent/pull/101) [`a60bd23`](https://github.com/DavideCarvalho/nestjs-agent/commit/a60bd2359bcdfa51c22fea60034635a0a5b3af41) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Ship a `MemoryProvider` you can actually run: `InMemoryMemoryProvider`, plus the fixtures an adapter
  is held to.

  Memory has shipped an SPI, a `remember` tool and a `memory:digest` checkpoint, and no storage — so
  every deployment that wanted the feature wrote a provider first, including the specs. There was no
  implementation of the interface anywhere in this repository, which meant the rules the SPI's own
  documentation states were prose rather than something executable.

  `InMemoryMemoryProvider` is the whole interface:

  - `list` returns only records at the scopes it was given. The gate is in the LOOKUP, not after it:
    the library drops out-of-scope records it is handed, but that is a backstop, and an adapter that
    leans on it has made privacy a property of its caller.
  - `write` upserts on (`scope`, `key`) and carries `pinned` across the rewrite. An upsert that reset
    the flag would silently unpin a record the next time the agent restated the same key.
  - `write` refuses an agent-authored record at any scope but the actor's own — the storage half of
    `memoryWriteVerdict`'s third rule. A human-authored one at a wider scope is allowed, because that
    is what a host console publishing an organisation's policy does, and whether that person may write
    there is a question `memoryWriteVerdict` answers with facts a provider is not handed.
  - `forget` deletes only from the actor's own scope, so an id alone cannot reach a tenant's or the
    deployment's memory. A missing id and somebody else's id answer identically.
  - `pin({ id, pinned })` is the operator act the SPI has no method for, on purpose: a pin grants a
    fact a permanent place in every future prompt, so nothing an agent can reach may set it.

  `{ recall: true }` also serves `search`, ranked by word overlap. Word overlap is not a relevance
  model; it is deterministic, and it exercises the path a host with an index takes — including the
  clause that is easy to miss, where every record sharing a ranked key has to travel or the block
  renders an organisation's value as the actor's own. Without the option there is no `search` property
  at all, which is the switch `offerMemories` reads.

  `everyMemoryField(ctx)` and `expectedMemoryRecord(...)` are the round-trip fixtures, typed
  `Required<StoreMemoryInput>` and `Required<MemoryRecord>` the way `EVERY_MESSAGE_FIELD` and
  `everyRunStartField` are. A field added to either shape fails to **compile** in the fixture until it
  is filled in, which is earlier than any assertion — an origin field an adapter silently drops is
  invisible to a test that asserts only on the fields someone remembered.

### Patch Changes

- [#101](https://github.com/DavideCarvalho/nestjs-agent/pull/101) [`a60bd23`](https://github.com/DavideCarvalho/nestjs-agent/commit/a60bd2359bcdfa51c22fea60034635a0a5b3af41) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `InMemoryMemoryProvider` holds two parts of the `MemoryProvider` contract it was stating but not
  keeping. Both matter more here than in any other adapter: this is the shape a host copies when it
  writes its own provider, so a divergence between the reference and the SQL adapters teaches the wrong
  contract.

  - `search` now returns records **most-relevant-first**, as `MemoryProvider.search` requires. The
    relevance ranking was computed and then dropped, and the results came back in whatever order the
    map happened to hold them. That is not cosmetic: `resolveMemoryDigest` selects by a record's
    POSITION under `ranked` rather than by scope, so a provider returning the right set in the wrong
    order hands the prompt ceiling a relevance judgement nobody made — and silently keeps the wrong
    memories when there are more matches than `maxMemories`. Records sharing a key stay adjacent, and a
    pinned record whose key ranked nothing sorts last, because the digest lifts pinned entries ahead of
    the ceiling anyway and placing one among the ranked would cost a slot the query did ask for.
  - The store and its callers no longer share objects. `write` filed the caller's `origin` by reference
    and returned the very record it had stored, and `list`/`all` handed out the live map values — so a
    consumer mutating anything it read, or mutating an input after the write returned, silently
    rewrote the store. Every value crossing the boundary is now a copy, `origin` included, which is
    what a SQL adapter gets for free by mapping rows.

  The specs that pin these are the discriminating kind: an order-sensitive assertion over more than one
  result, and a mutate-then-re-read for each of the four ways a caller can reach a stored object.

## 0.10.0

### Minor Changes

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `RecentRunRow.parentRunId` — the delegation edge reaches the read-model.

  The run row records which turn delegated it, but the governance read-model did not carry it, so every
  surface built on `recentRuns` / `runsPage` / `runDetail` / `threadDetail` still saw a flat list of runs.
  `RecentRunRow` gains `parentRunId: string | null`, mapped by all three adapters — `null` for a turn
  nobody delegated, and for any run recorded before the column existed.

  That is what a console needs to draw a delegation tree and roll a child's cost up to the turn that asked
  for it. For a DETACHED child it is the only link there is: it outlives its parent's turn, so nothing in
  the transcript pairs them.

  `RecentRunRow.status` also stops documenting three terminals. `cancelled` is a fourth value these rows
  carry, and a consumer computing a failure rate has to be able to leave it out rather than fold it into
  `failed` — a user pressing Stop is not an error.

  **Upgrading.** No schema change and no behaviour change; an existing consumer that ignores the new field
  is unaffected. A consumer asserting exhaustively on a run row (`toEqual`) will see the added key.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Make a finished turn read back as a finished turn.

  A standalone client built against the published surface found two things the unit tests could not,
  because both only appear once something reads a thread BACK.

  **A turn's tool results were never persisted onto its message.** The loop appended the assistant
  message at `persist:assistant:<i>` — before the tools ran — and then attached the results to an
  in-memory object nothing ever wrote. The outputs did reach the `agent_tool_call` table, and the
  MikroORM adapter hid the consequence by rebuilding `toolResults` from those rows on read; Drizzle and
  the in-memory store return the column as written. So on those two, every tool on a reopened thread
  sat at `state: 'input-available'` forever — a UI renders that as "Running", under an answer that had
  already quoted the tool's output.

  The fix is one write, not three reads. `AgentStore` gains a **required** `setMessageToolResults`, the
  loop calls it once with the turn's complete result list, and all three adapters return the same
  column. Making it optional would have reproduced the defect for any store that declined it, silently;
  a missing method should fail to compile. MikroORM now returns the message's own results and consults
  the tool-call rows only for a message that carries calls and none of its own, so what it returns for
  anything the loop writes is byte-for-byte what the other two return, rather than a second derivation
  that happens to agree.

  **Inject-mode retrieval and structured output never reached a client at all.** Both were recorded
  with `recordToolCall` — the tool-call table only. Neither was added to the message's `toolCalls`, and
  neither emitted a stream frame, so the passages behind a grounded answer were invisible to every
  client and a validated `outputSchema` value was unreachable except by reading the store directly.
  Both now ride the whole delivery path an ordinary tool call has: the assistant message's
  `toolCalls`/`toolResults`, the `agent_tool_call` row, and a live `tool-input-available` +
  `tool-output` frame pair. No new frame kind and no new message field — a client that renders tool
  calls renders both with no change, and `@dudousxd/nestjs-agent-react` folds the retrieval into its
  provenance block on the shape of its output rather than the tool's name.

  Docs claiming these already worked (`guides/rag.mdx`: "the same surface, so citations render
  identically"; `guides/structured-output.mdx`) are now true rather than aspirational.

  **No checkpoint moved.** Every value involved is settled by a checkpoint the turn already took, so
  the results write lives inside `stream:tool-outputs:<i>` and the two synthetic calls keep their
  existing `persist:retrieval:<messageId>` / `persist:structured:<messageId>` positions. A turn that
  configures nothing new records a byte-identical sequence, so no run in flight can be refused on
  resume, and none of this needed a `patched` marker.

  **Migrating a custom `AgentStore`:** add `setMessageToolResults(messageId, results)` — replace that
  message's `toolResults` with `results`. Adapters using the bundled schemas need no migration; the
  `tool_results` column already exists.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Forking a thread no longer drops a message's `attachments` and `runId`.

  Both SQL adapters copied a forked message field by field and omitted two of them, while the
  in-memory store copied the whole object — a three-way divergence in what "fork" means. So forking a
  thread silently lost its attachments, and the copied messages could no longer be attributed to the
  turn that wrote them. Nothing logged; the fork just came back thinner.

  The fixture that catches this is now shared rather than rewritten per spec:
  `EVERY_MESSAGE_FIELD` is exported from `@dudousxd/nestjs-agent-testing`, typed
  `Required<Omit<AppendMessageInput, 'threadId' | 'role' | 'content'>>`, so a new optional field on
  the input fails to COMPILE until it is filled in — and then fails every adapter's round-trip test
  until that adapter carries it. A consumer writing its own `AgentStore` can hold it to the same
  contract.

  A forked message keeps the `runId` of the turn that produced it. The copy is that same message, so
  the attribution is truthful, and a run-scoped read still resolves through the run's own thread —
  which is the original, never the fork.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - List staged attachments, and find the ones nothing points at any more.

  `stage()` creates media at upload time, before any message exists. A user who attached a file and
  then closed the tab left bytes in the host's object store with nothing referencing them — no
  message, no listing, no sweep, no way to even measure how much was there. In a product where an
  attachment may be a contract or a medical record, keeping it for ever by omission is the worse
  default.

  The two sides of the problem are held by different owners, so neither could answer alone, and both
  now have a method:

  - **The host owns the bytes.** `AttachmentStagingStore` gains optional
    **`list({ actor, stagedBefore?, limit? })` → `StagedAttachment[]`** — `mediaId`, `name`,
    `contentType`, `sizeBytes`, `createdAt`. Deliberately no `url`: a url is minted per turn by
    `resolve` so it can be short-lived, and a listing that returned one per row would undo that just
    to render a file list.
  - **The library owns the references.** `AgentStore` gains optional
    **`referencedMediaIds(actorRef, mediaIds)` → `string[]`**, the inverse query: of these ids, which
    a message that still exists carries. Implemented in `store-mikro-orm`, `store-drizzle` and
    `InMemoryAgentStore`.

  `AgentService.collectableAttachments(actor, { olderThan })` composes them into the candidate set for
  a sweep — inventory, minus references, minus anything too recent to be garbage. It returns
  candidates and **never deletes anything**: the bytes are the host's, and so is the decision.
  `AgentService.listAttachments(actor)` and `GET /agent/attachments` expose the inventory itself.

  **References are re-derived, never latched.** `truncateFrom` deletes messages — which is exactly
  what regenerating a turn does — so media that was referenced becomes unreferenced again. A flag set
  when a message is sent would never be unset by that delete and would pin the bytes for ever. Every
  call answers from the surviving message rows instead.

  **`olderThan` is required and has no default.** Freshly staged media is an upload in flight, not
  garbage. How long a composer may sit open with a file attached is the host's knowledge, and a
  library-chosen grace period would eventually delete a file someone was about to send. It is pushed
  down to `list` as `stagedBefore` _and_ re-applied to the result, so a store that ignores the hint
  cannot turn this into that bug silently.

  **Both halves must answer or the sweep refuses** (`501`). An unanswerable reference query means
  "cannot tell", and reading it as "nothing is referenced" would hand back every attachment the actor
  ever sent, marked safe to delete.

  **No schema change.** `referencedMediaIds` reads the `attachments` JSON column that has carried
  message attachments since they shipped, so there is nothing to migrate and nothing to backfill — an
  existing deployment gets correct answers on its existing rows the moment it upgrades. A normalized
  index table would have been faster to query and would have reported every attachment written before
  the backfill as unreferenced, which on a delete path is the one failure mode worth designing out.

  Both reads are per-actor without exception, and `GET /agent/attachments` has no `threadId` filter:
  a thread's attachments already ride on its messages in the thread payload, so a second ownership
  path would be new risk for information the client already has. Collection is not an HTTP route at
  all — it needs a host-chosen threshold and ends in deleting files, so it stays an in-process call.

  `@dudousxd/nestjs-agent-testing` also gains `InMemoryAttachmentStagingStore`, a complete staging
  store (including the per-actor checks) for testing a sweep end to end.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Let an agent ask the user a structured question, and wait.

  The only way a run could pause for a human was `awaitApproval` — a yes/no about a tool call already
  proposed, mid-work. The other direction was missing entirely: collecting the SCOPE, before the work,
  while changing course is still cheap. Two surfaces now do it, and they were built to be
  indistinguishable downstream.

  **A configured intake.** `@Agent({ intake: { questions, preamble?, when? } })` declares the questions;
  the turn passes through them before its first model call. Because they are authored, the intake costs
  **no model call** and writes no usage row — and `questions.length` is known before the form appears,
  which is the only honest way a client can render "Question 1 of 3" rather than discovering a fourth
  halfway through. `when: 'thread-start'` (the default) asks once per thread; `'every-turn'` asks before
  each one.

  **A model-callable `ask`.** `forRoot({ ask: true })` (or `@Agent({ ask })`) offers the model a built-in
  `ask` tool for the case an intake cannot anticipate. Its input schema _requires_ a pre-picked
  `defaults` on every question: "I have pre-picked what I would choose, so confirming is enough" is the
  claim the surface rests on, and a schema is the only place to make it mandatory rather than
  aspirational. A malformed question set comes back as an ordinary tool failure carrying the validation
  issues, so the model fixes its own mistake instead of failing the run or parking a person.

  **One shape, one resume path.** Both write a single pending tool-call row named `ask`
  (`toolType: 'action'`, `status: 'pending_approval'`, so it surfaces in the existing approvals inbox),
  both emit the same new `elicitation` stream frame followed by the ordinary `tool-output` frame, and
  both park on the same `tool:<runId>:<callId>` durable signal a HITL approval already waits on. New
  `POST /agent/tool-call/answer` and `/skip` mirror `approve`/`reject`, with the same ownership check.
  `AgentLoopHooks` gains an optional `awaitAnswers`; a host that only implemented `awaitApproval` still
  completes an elicitation, reading approve as "confirmed the pre-picked answers" and reject as "skipped".

  **An omitted question takes its own default**, resolved server-side against the request the run
  already holds rather than in the client — so "just pressed enter" and "picked exactly the defaults"
  persist identically, and a client that never rendered the defaults cannot submit a blank. The settled
  row records `defaulted: string[]` so an auditor can still see which questions a human touched.
  **A skip is not a confirmation:** it lands on the same values, and persists as `rejected` rather than
  `executed`, because proceeding on an assumption the user declined to confirm is a different fact from
  proceeding on one they chose. Nobody answering parks the run indefinitely, exactly as an approval
  does — there is no intake timeout, because a timeout that applied the defaults would manufacture
  consent from silence.

  `ToolKind` gains a fourth member, `'ask'`. No `ToolSpec` carries it: `ask` is never registered, has no
  handler, and is offered to the model straight from module config — so the branch that decides whether
  a call parks on a human can never be settled by a process-local registry lookup. As with the other
  kinds, the value is resolved INSIDE the already-journaled `persist:toolcall:<callId>` checkpoint and
  read back from there on every replay.

  **Checkpoints.** An intake spends one position for its verdict (`intake:ask`) plus two more on the
  turns it asks; an `ask` reuses the approval path's own names and adds one (`stream:elicitation:<id>`).
  The intake's verdict is RETURNED from `intake:ask` rather than recomputed, because by the time a
  resume replays the turn the first attempt has already appended the intake's own assistant message to
  the thread — recomputing "has this thread been asked?" would answer no on the way in and yes on the way
  back, and land `stream:step-start:0` where the history holds `signal:tool:`. No `patched` marker is
  spent for either surface: an intake is reachable only through new config and an `ask` only through a
  journaled kind no existing run recorded, so no in-flight run can land on any of these positions.
  Declare neither and a turn's checkpoint sequence is byte-identical.

  `AgentStore.runForToolCall` now answers from the tool call's OWN `runId`, falling back to the thread's
  `activeStreamId` only for rows written before calls carried one. Keying off the active stream assumed
  a thread holds exactly one live run; it is about to hold more, and then the answer would reach a run
  waiting on nothing. Fixed in all three shipped adapters.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Record which run wrote each message.

  `AppendMessageInput`/`StoredMessage` gain an optional `runId`, persisted by all three store adapters,
  and the loop stamps it on the user message and on every assistant message. Until now nothing tied a
  message to a turn, so a reader could only compare timestamps against the run's `startedAt` — and a
  regenerate breaks that comparison: it truncates the replaced answer and re-answers the surviving user
  message without appending a new one, leaving one prompt followed by the newest answer. Walking
  forward by time then hands the older run the replacement's text.

  `GovernanceRunSampleSource` (`-evals`) now attributes on the stamp. A transcript carrying no stamp at
  all is treated as legacy and still resolved by time; a stamped transcript holding nothing for a run
  reads as empty for that run rather than borrowing a neighbour's answer. A regenerated run may still
  borrow the prompt it re-answered — that message genuinely is its input — but never an answer.

  The MikroORM adapter adds the column on its next boot through the schema heal it already runs. The
  Drizzle adapter's `ensureAgentSchema` was `CREATE TABLE IF NOT EXISTS` only, inert against an
  existing table, so it gains an additive-column pass that adds `run_id` where the table predates it.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Read a thread's default agent without reading the thread.

  Every `chat()` call that does not name an agent asked the store for the thread's `defaultAgent`, and
  asked for it with `getThread` — which returns the entire transcript: every message, every persisted
  tool output. On a 20-turn thread with 8 KB tool results that is **173 KB read per turn, outside the
  workflow, discarded immediately** for one nullable string.

  Each store gains `defaultAgentForThread(threadId)`, a one-column read on the primary key, and
  `AgentService` prefers it. On the same 20-turn thread the read goes from two statements returning 41
  rows (173,054 bytes) to one statement returning one column (29 bytes).

  The method is probed structurally against the exported `ThreadDefaultAgentReader` shape rather than
  added to the `AgentStore` SPI: it is an optimization a store either offers or does not, and a store
  that predates it still answers correctly through the full `getThread` read.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Record which run delegated a run.

  `RecordRunStartInput.parentRunId` is populated for awaited and detached children alike, by both
  runners — and all three stores dropped it on the floor. Each declared its own structural parameter
  for `recordRunStart` (`{ runId; threadId; actorRef; agentName?; promptHash? }`) instead of the SPI's
  input, so a field added to the input was accepted and discarded with nothing to fail.

  What that costs is the delegation tree. The durable runtime journals the parent→child edge, but only
  there: a reader of run ROWS — every reliability and cost surface — cannot pair a child with the turn
  that asked for it, so a delegation's spend is unattributable. For a **detached** child it is worse,
  because it outlives its parent's turn, so nothing in the transcript pairs them either.

  Both SQL adapters gain a nullable `parent_run_id` column on `agent_run` and persist it; the
  in-memory store carries it on its run row and its `GovernanceRunRow`. All three now take
  `RecordRunStartInput` itself, so the next field cannot drift the same way, and each adapter's spec
  round-trips a fixture typed `Required<RecordRunStartInput>` — which fails to COMPILE until the row
  can name what the input carries.

  The console reads the edge off `RecentRunRow`: the run drill-down names the run that delegated the
  one being read, which for a detached child is the only link back to the turn that asked for it.

  **Upgrading.** Nothing to run by hand on either adapter.

  - MikroORM: `ensureAgentSchema` heals it, and the column is appended last, so the diff is a plain
    `alter table agent_run add column parent_run_id text null` on every dialect — no SQLite table
    rebuild.
  - Drizzle: `CREATE TABLE IF NOT EXISTS` is inert against an existing table, so `parent_run_id` is
    also registered in the additive-column pass and lands on the next boot.

  Runs recorded before the upgrade keep `parent_run_id` null: the edge for a turn that has already
  finished exists only in the durable journal, and is not backfilled.

### Patch Changes

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Name `cancelled` in the row types a run settles into.

  `RecordRunEndInput.status` has three terminals — `completed`, `failed`, `cancelled` — but all three
  stores declared `recordRunEnd`'s parameter as the narrower `'completed' | 'failed'`, and their run
  row and column types listed only those. Method parameters are bivariant, so this typechecked and the
  value was written through: the data was right and every reader was told a cancelled run is
  impossible. A consumer computing a failure rate had no type-level way to leave a user pressing Stop
  out of it.

  The parameter, the `AgentRunStatus` column type on both SQL adapters, and the in-memory store's run
  rows now all name it. `DrizzleGovernanceQueries` also accepts `cancelled` as a run-status filter —
  it previously short-circuited an unrecognized value to an empty page, so an operator could not list
  the cancelled runs that were already in the table.

  Each adapter's db spec now derives its terminal fixture from `RecordRunEndInput['status']` and the
  row's own status type, so a fourth terminal fails to compile until the row can name it. A runtime
  test cannot catch this — bivariance means the value round-trips either way.

  **Upgrading.** No schema change: `status` is a plain string column on both adapters, with no enum or
  check constraint to widen.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Persist and return a thread's `defaultAgent` on every adapter.

  `AgentStore.updateThread({ defaultAgent })` decides which agent answers the next turn on a thread
  when the caller names none. Neither SQL adapter could answer with it.

  **Drizzle had no `default_agent` column at all** — not in `schema.ts`, not in its DDL — and no
  `updateThread`, so a host on that adapter got a 501 from `PATCH /agent/threads/:id` and could never
  set the field. It now has the column, `updateThread` (title and/or `defaultAgent`, each touched only
  when present in the patch, `null` clearing the default), and the read side below.

  **MikroORM had the column and wrote it, but `toSummary` never emitted it**, so `getThread` reported
  no default agent and the next turn silently fell through to the module default. The stored value was
  reachable only by querying the entity directly, which is what its own test did — the round-trip
  through the store was never exercised.

  Both adapters now report `defaultAgent: string | null` on every thread summary/detail, and a fork
  carries the source thread's default (the in-memory reference store too — a fork continues the same
  conversation, so the same agent answers it).

  A `Required<UpdateThreadInput>` fixture in each adapter's db spec and in
  `packages/testing/src/thread-fields.spec.ts` fails to COMPILE when the patch gains a field the
  adapter does not round-trip — the same gate `message-fields.spec.ts` uses, which is what caught two
  silently-dropped message fields.

  **Upgrading.** Drizzle's `ensureAgentSchema` is `CREATE TABLE IF NOT EXISTS`, inert against a table
  that already exists, so `default_agent` is added through the additive-column pass it already runs at
  boot — an existing deployment calling `ensureAgentSchema` needs no action. A host running its own
  drizzle-kit migrations instead must add `ALTER TABLE agent_thread ADD COLUMN default_agent TEXT`.
  MikroORM needs nothing: the column already shipped.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Persist a message's `attachments` in the Drizzle and in-memory stores.

  `AppendMessageInput` has carried `attachments` all along and the MikroORM adapter persisted them,
  but the Drizzle adapter had no such column — not in its `schema.ts`, not in its DDL — and neither it
  nor the in-memory store wrote the field. So the same conversation round-tripped differently
  depending on which adapter the host had wired: a user attached a PDF, reopened the thread, and it
  was gone, with nothing logged. `ensureAgentSchema` adds the column to a table that predates it.

  A round-trip test now asserts that every field `appendMessage` accepts comes back out of
  `getThread`, which is the check whose absence let a whole field go unwritten.

## 0.9.0

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

## 0.8.1

### Patch Changes

- Updated dependencies [[`70114eb`](https://github.com/DavideCarvalho/nestjs-agent/commit/70114ebb9a7a3702d2efdb11e0dea6956a7ba8db)]:
  - @dudousxd/nestjs-agent-core@0.10.0

## 0.8.0

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

## 0.7.0

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

## 0.6.1

### Patch Changes

- Updated dependencies [[`6263338`](https://github.com/DavideCarvalho/nestjs-agent/commit/6263338cf86df7b51cb082d5d2d575987cd13383)]:
  - @dudousxd/nestjs-agent-core@0.7.0

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

### Patch Changes

- Updated dependencies [[`eb3aaff`](https://github.com/DavideCarvalho/nestjs-agent/commit/eb3aaff531cc923de1d0bccebb2b0690b4c92263), [`781a30f`](https://github.com/DavideCarvalho/nestjs-agent/commit/781a30f6579d5b9a69f341b8eeac02c273dbb8a1)]:
  - @dudousxd/nestjs-agent-core@0.6.0

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

### Patch Changes

- Updated dependencies [[`1c44152`](https://github.com/DavideCarvalho/nestjs-agent/commit/1c4415295a6280527e762f13e6aed48099ae5ca5), [`1c44152`](https://github.com/DavideCarvalho/nestjs-agent/commit/1c4415295a6280527e762f13e6aed48099ae5ca5)]:
  - @dudousxd/nestjs-agent-core@0.5.0

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
