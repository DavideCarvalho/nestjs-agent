# @dudousxd/nestjs-agent-codegen

## 0.15.0

### Minor Changes

- [#355](https://github.com/DavideCarvalho/nestjs-agent/pull/355) [`9ddad78`](https://github.com/DavideCarvalho/nestjs-agent/commit/9ddad7833f9403e8f22bcc8a502519d413ae934c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Generative UI: the app's design system inside the sandbox, and per-channel generative UI.

  - **Theme, Tailwind and the kit in the sandbox.** `defineSandbox({ theme, tailwind, kit })` (and `AgentGenuiModule.forRoot({ sandbox: { … } })`): `theme` (on by default) puts the host page's CSS custom properties on the frame's `:root` and follows light/dark changes without reloading it; `tailwind: true` inlines Tailwind CSS v4 (`@tailwindcss/browser`, now a dependency of core) with an `@theme` mapped from the host's variables, so `bg-primary` or `rounded-lg` work offline; `kit` inlines the app's own components (a bundle of `Kit`, React and ReactDOM) and lets the model write the view as JSX (`jsx`, a `function App()`), compiled in the frame by a small self-contained transpiler that draws a partial program as soon as it parses. The model is told the kit's components and props (generated from their TypeScript types), the theme's variable names and the Tailwind rule. New isomorphic helpers in `@dudousxd/nestjs-agent-core/genui`: `transpileJsx`, `prepareSandboxJsx`, `sandboxJsxRuntime`, `kitDocsToModelText`, `themeVarsFromCss`, `tailwindThemeCss`, `hostThemeCss`, `collectHostThemeVars`, `watchHostTheme`, `SandboxClientConfig`…
  - **The kit tooling** (Node-only, `@dudousxd/nestjs-agent-core/genui/kit`): `generateSandboxKitDocs`, `writeSandboxKitDocs`, `buildSandboxKitBundle`, `sandboxKitDiscovery`, `resolveSandboxServer`, `SANDBOX_KIT_MANIFEST_KEYS`. The Vite plugin is `genuiSandboxKit()` from the new `@dudousxd/nestjs-agent/vite` entry: in dev it builds and serves the kit and the Tailwind runtime under `/@genui-sandbox-kit/` (with the app's own Tailwind directives from `tailwindCss` — custom variants, `@utility`, `@theme` — on the descriptor as `tailwind.css`), writes `.genui/sandbox-kit.json` and rebuilds (with HMR) when a component changes; in a build it emits them as hashed assets plus `genui-sandbox-kit.json`, listed in the Vite manifest. `AgentGenuiModule.forRoot({ sandbox: { kit: true, tailwind: true } })` — or a `defineSandbox({ kit, tailwind })` in the catalog itself, kept under its name (`SandboxDefinition.sandboxOptions`) — finds them there (`sandboxKit: { root, descriptor, manifest, kitUrl }` overrides where), and `GET <base>/config` now answers `genui: { sandbox }` so the React renderer (`SandboxView`, `createSandboxRenderer({ config, theme })`) knows where the assets are; it waits for that config before deciding a JSX view has no kit. The frame mirrors the host's `color-scheme` only when it sets one (`hostThemeCss(vars, { colorScheme })`), so it is never painted opaque. `vite`, `typescript` and `@resvg/resvg-js` are optional peers.
  - **Per-channel generative UI.** `AgentGenuiModule.forRoot({ channels: { web, mobile, whatsapp, telegram, email, default } })` sets, per channel, the mode (`tree`, `per-component` or `text`), streaming, sandbox and rendering (`native`, `text`, `html`); each turn is offered only the tools of its channel's mode, narrowed to what that channel can draw, and told so. A turn's channel is `turnChannel(pageContext)`: `pageContext.channel` (or `AgentService.send({ channel })`), a text channel's adapter `kind`, else `web` — no channel (AG-UI, the HTTP chat, A2UI) is `web`; channel adapters stamp their `kind`. `channel` is now on `ToolDescribeScope`, `AiToolCtx`, `PromptContext` and `GenuiCatalogScope`. Components say what they are on a channel with `defineComponent(def, { channels: { whatsapp: (props) => ({ text, buttons, list, image }) } })` (or `false` to opt out); `renderChannelMessages`, `channelCatalog`, `resolveGenuiChannel`, `channelButtonAction` do the work, and `chartImages()` / `chartSvg()` (`@dudousxd/nestjs-agent-core/genui/chart-image`) draw the builtin `Chart` as a PNG for channels that take images. The genui setup is injectable as `AGENT_GENUI` (`AgentGenui`).
  - **Text channels draw natively.** A channel configured in `AgentGenuiModule.forRoot({ channels })` (by its adapter's new `kind`: `whatsapp`, `telegram`) sends each component as its conversion — text, reply buttons, a list, an image — in the order it came in the text, its text summary otherwise; a pressed button (or list entry) is the user's next turn as a UI action, also when the provider forwards only the label (Whatsmiau). Adapters gain `kind`, `capabilities.lists` and a list `OutboundMessage` (WhatsApp Cloud interactive lists, Evolution API / Whatsmiau `sendList`, a Telegram inline keyboard of one row per entry). `ChannelOptions.genui` (`false` turns it off) overrides the app's setup. Codegen's `GET /config` type carries the optional `genui` field.

## 0.14.0

### Minor Changes

- [#319](https://github.com/DavideCarvalho/nestjs-agent/pull/319) [`6b7de84`](https://github.com/DavideCarvalho/nestjs-agent/commit/6b7de84eca7dd094baf21a19be8144d8ae2409da) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The generated client now includes the action-proposal routes: `agent.actionProposals.list`, `.approve` and `.reject`, under `/agent/threads/:threadId/action-proposals`. The guard spec that checks codegen against the library's controllers now scans every controller in `@dudousxd/nestjs-agent`, not only `src/controller/`. It now also sees the proposal, resumable-upload and AG-UI routes.

### Patch Changes

- [#319](https://github.com/DavideCarvalho/nestjs-agent/pull/319) [`6b7de84`](https://github.com/DavideCarvalho/nestjs-agent/commit/6b7de84eca7dd094baf21a19be8144d8ae2409da) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **Security:** proposal routes no longer return raw store rows. `GET /threads/:threadId/action-proposals`, the approve/reject routes, text decisions, the AG-UI decision event and the approval port all returned the stored row. That row includes the worker's execution lease token (which lets its holder settle the work), the delivery lease, the tool's `idempotencyKey`, and the execution address (`preparationInput`, `executionContext`). They now return `ActionProposalView` / `ActionProposalMutationView` (new in core, built with `toActionProposalView` / `toActionProposalMutationView`), which leave all of those out. `AgentApprovalPort`'s proposal methods and the React client's proposal types now use the view types. The codegen mirror no longer declares `idempotencyKey`.

## 0.13.0

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

## 0.12.0

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

## 0.11.0

### Minor Changes

- [#241](https://github.com/DavideCarvalho/nestjs-agent/pull/241) [`68aee17`](https://github.com/DavideCarvalho/nestjs-agent/commit/68aee1787ea8a63279859ed99376849e1e8937b1) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Send while the agent is still answering: the message queue.

  - **Server.** `POST <base>/chat` on a thread with a turn running queues the message on the thread (persisted, per-thread FIFO) and answers `202 { queued: true, messageId, position, queue }` instead of starting a second, concurrent turn. When the turn settles the next queued message starts under its own id (inline and durable runners — the durable drain is journaled and spawned with `ctx.startChild`, so it never starts twice), announced as a final `queue` frame (`started: { messageId, runId }`) before the terminal. `mode: 'interrupt'` cancels the running turn and runs the message next; `mode: 'queue'` always queues. A failed turn or a Stop pauses the queue; an exhausted quota pauses it as the next message starts. New routes: `GET`/`DELETE threads/:id/queue`, `POST threads/:id/queue/resume`, `PATCH`/`DELETE queue/:messageId`; `GET threads/:id` carries `queue`. Admission is now a compare-and-set on the thread's active run (one turn per thread across pods; a stale holder left by a crashed process is replaced). `AgentService.send()` queues; `AgentService.chat()` stays start-or-refuse for in-process callers (`409 run_active` on a busy thread); `regenerate` on a busy thread is `409`.
  - **Core.** `ChatQueueStore` (probed by `isChatQueueStore`), `QueuedMessage`/`ChatQueueState`/`QueuePause`, the `queue` stream event, `ThreadDetail.queue`, `AgentRunner.start(input, { runId })` and the optional `isRunActive`. `InMemoryAgentStore` implements the queue.
  - **Stores.** Drizzle and MikroORM add `agent_queued_message` and `agent_thread.queue_pause` on boot (MikroORM: in `agentManagedTables()`); both implement `ChatQueueStore`.
  - **Testing.** `CHAT_QUEUE_STORE_CONTRACT` — framework-agnostic cases any `ChatQueueStore` can run.
  - **React.** `composer.submit()` / `sendMessage` mid-turn queue instead of being refused; `useAgentChat({ whileRunning: 'queue' | 'interrupt' | 'block' })`; `chat.queue` (`items`, `paused`, `add`, `remove`, `edit`, `move`, `clear`, `resume`, `error`); `chat.transcript.queued` renders waiting messages as pending user messages; the chat attaches to a queued turn when it starts, and starts a queue left waiting when the thread loads. `AgentBackend` gains the optional `enqueueMessage`, `getQueue`, `updateQueuedMessage`, `removeQueuedMessage`, `clearQueue`, `resumeQueue`; a `202` from `openChatStream` is reported as `queued`.
  - **Codegen.** The five queue routes, and `queue` on the thread detail.

## 0.10.1

### Patch Changes

- [#236](https://github.com/DavideCarvalho/nestjs-agent/pull/236) [`9bf7efd`](https://github.com/DavideCarvalho/nestjs-agent/commit/9bf7efd574aabcceeebd9730ddbe5f2eaaae6822) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Chat protocol gaps found moving a sandboxed runner onto the React client:

  - **Error answers reach the hooks.** `AgentHttpError` (and `MediaUploadError`) carry the server's `code`, the parsed `body`, and its `message` as their own `message`, so a failed send, a refused upload or a refused approve/answer shows the server's words. `onHttpError` on `<AgentProvider>` / `AgentClient` sees every error answer before it is thrown (a resume's `404` excepted).
  - **A send's `model` is that turn's only.** `chat.models.select(id)` belongs to the conversation it was made in (switching threads drops it), `pinToThread(id)` replaces the pick, and `chat.models.pinned` is the thread's pin.
  - **Model lock.** `ModelCatalogView.locked: { model, reason? }` and `AgentCatalogEntry.lockedModel`; the server runs every turn of a locked agent on that model and refuses a send naming another. `useModels().locked` / `chat.models.locked`.
  - **Quota soft limit.** `QuotaWindow.warnAt`, `QuotaReport.warning: { period, ratio, reason? }`, `quotaWarning(windows)`, `quota: { limits, warnAt }` on the ledger provider, and `useQuota().warning` / `chat.quota.warning`. `QuotaWindow.usedTokens` is optional, for USD-only budgets.
  - **Who answered a question.** `answer`/`skip` take `via`; the settled outcome carries `answeredBy` / `answeredVia` (streamed, persisted, replayed), read into the elicitation block's `outcome`.
  - `docs/stream-protocol.md`: error bodies, the regenerate contract (`regenerate: true` never stores the user message again), and how a runner numbers a stream it rebuilds from checkpoints (ids only increase, gaps allowed).

## 0.10.0

### Minor Changes

- [#230](https://github.com/DavideCarvalho/nestjs-agent/pull/230) [`37e2c2d`](https://github.com/DavideCarvalho/nestjs-agent/commit/37e2c2de47b5ec36dc209a0f11678f3627a93fa6) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - One way to do each thing: quota, attachment limits, upload route, client config.

  - **Quota** is a single option: `quota: { limits: { day?, month? } }` (ceilings on the built-in ledger provider) or `quota: yourQuotaProvider`. Either way `GET <base>/quota` reports it and a blocked send is refused with `429`; omitted, usage is reported and never enforced.
  - **`GET <base>/config`** serves what clients used to repeat: `{ attachments: { enabled, upload: 'multipart' | 'resumable' | null, maxBytes, allowedContentTypes, maxPerMessage }, models: { enabled }, quota: { enforced }, identity: { anonymous } }` (`AgentClientConfig` in core). React: `AgentBackend.getConfig` / `AgentClient.getConfig`, `useAgentConfig()`, and `useAttachments` (so `chat.composer.files`) takes `accept` / `maxBytes` / `maxFiles` defaults from it.
  - **Attachment limits** have one source: the staging store's `describe()` when it declares them (`AgentMediaAttachmentsModule` does — its `maxBytes` / `allowedContentTypes` are then the only limits in force), else `AgentModule`'s `attachments: { maxBytes, allowedContentTypes }`, else the defaults. New optional SPI member `AttachmentStagingStore.describe()`.
  - **Upload route**: `POST <base>/attachments` is mounted always and live whenever a staging store is bound (`501` otherwise); with `AgentMediaAttachmentsModule` the resumable `<base>/attachments/uploads` routes are the documented path (`config.attachments.upload === 'resumable'`).
  - **History attachments**: `GET <base>/threads/:id` re-mints each attachment's url from the staging store by `mediaId` on every read, so an old turn's presigned link never shows expired.
  - **One run field**: a thread's running turn is `activeRunId` everywhere (summary and detail).

  **Breaking**

  - Removed `AgentModuleOptions.quotaLimitTokens`, `quotaLimits`, `quotaProvider` and the `QuotaStore`-typed `quota`; `LedgerQuotaStore` is removed and `LedgerQuotaProvider`'s constructor is `(store, limits?)`. The module no longer binds `AGENT_QUOTA_STORE`, so the loop's own `quota:check`/`quota:bump` steps no longer run under `AgentModule` (enforcement is the send gate) — drain in-flight durable runs of a deployment that used `quotaLimitTokens` or a `quota` store before upgrading. Migrate: `quotaLimitTokens: N` → `quota: { limits: { day: { tokens: N } } }`; `quotaLimits: L` → `quota: { limits: L }`; `quotaProvider: P` → `quota: P`.
  - Removed `GET <base>/quota/today` and `AgentService.quotaToday` (use `GET <base>/quota`).
  - Removed `attachments.upload` (`AgentModuleOptions`) and `attachmentsUpload` (`forRootAsync`): the upload route follows the bound staging store. `DEFAULT_MAX_ATTACHMENT_BYTES` / `DEFAULT_ALLOWED_ATTACHMENT_CONTENT_TYPES` now export from the package root's `attachment-limits` (same names).
  - `POST <base>/chat` accepts attachments only as `{ mediaId }` refs — an entry with any other key is refused with `400` (it used to be trimmed). React: `AttachmentsState.attachments` is removed; send `files.refs` (each item still carries its `attachment` for display).
  - `ThreadDetail.activeStreamId` is removed from core and every store's `getThread` — read `activeRunId`.

## 0.9.0

### Minor Changes

- [#215](https://github.com/DavideCarvalho/nestjs-agent/pull/215) [`104c3a6`](https://github.com/DavideCarvalho/nestjs-agent/commit/104c3a6a0cc0cbf2d6b101fb648daa2565e1b856) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Quota v2: budget windows, a pluggable QuotaProvider, and a send gate.

  - core: `QuotaProvider` SPI (`report({ actor, now? }) → { windows: [{ period: 'day' | 'month', usedTokens, limitTokens?, usedUsd, limitUsd?, resetsAt? }], blocked?: { period, reason? } }`), `AGENT_QUOTA_PROVIDER`, `exhaustedWindow`, `quotaPeriodRange`. Optional `AgentStore.usageBetween(actorRef, fromDay, toDay)`.
  - nestjs: `GET quota` answers the report. `LedgerQuotaProvider` (the default) reads the usage ledger — a day window (ceiling from the bound `QuotaStore`), plus a month window when the store has `usageBetween`. `AgentModule.forRoot({ quotaProvider })` binds your own (an AI-gateway budget); `quotaLimits: { day?, month? }` (tokens and/or USD) adds ceilings to the default. Either one turns on the send gate: a `blocked` report refuses `POST chat` with `429 { code: 'quota_exceeded', period, message }` before the turn starts. `GET quota/today` is unchanged.
  - stores / testing: `usageBetween` (and `quotaToday` delegates to it).
  - react: headless `useQuota({ backend, pollMs? })` (windows, `day`, `month`, `blocked`; re-read after every run a chat on the same backend settles); `AgentBackend.getQuota?` / `AgentClient.getQuota()`; `useAgentChat({ blocked })` refuses `sendMessage`/`regenerate` with `QuotaBlockedError` while a window is exhausted.
  - codegen: `GET /agent/quota` as `agent.quota.report`; `GET /agent/quota/today`'s response type now matches what it returns.

## 0.8.0

### Minor Changes

- [#213](https://github.com/DavideCarvalho/nestjs-agent/pull/213) [`a4dc582`](https://github.com/DavideCarvalho/nestjs-agent/commit/a4dc5823eea59e971404a53b4d7ce0fc7cda88b6) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Model catalog, per-thread and per-send model selection, model/agent picker hooks.

  - core: `ModelCatalog` SPI (`list({ actor, agent }) → { providers: [{ id, label, models: [{ id, label, description?, badges?, available, unavailableReason?, contextWindow? }] }], default }`), `staticModelCatalog`, `findCatalogModel`, `withSelectedModel`, `AGENT_MODEL_CATALOG`. `ModelTurnArgs.model`, `AgentRunInput.model`, `LlmStepEnvelope.model`, `ThreadSummary.model`, `UpdateThreadInput.model`. A turn with a selected model runs every call (answer, structured output, follow-ups, dispatched steps) on it and labels usage with it when the provider reports no model id.
  - nestjs: `AgentModule.forRoot({ models })`; `GET models?agent=` (`ModelsController`; empty catalog when none is bound); `POST chat { model }`; `PATCH threads/:id { model }` (`null` unpins). A model is refused with 400 unless the catalog lists it as available for the actor and agent — checked when pinned and again on every turn. Thread reads normalize `model` to `null`.
  - ai-sdk: `aiSdkModel(model, { resolveModel })` runs the picked id; without a resolver a gateway string id is swapped for the pick and a provider instance ignores it.
  - store-drizzle / store-mikro-orm / testing: `agent_thread.model` (nullable, added by `ensureAgentSchema`, copied on fork), `modelForThread`.
  - react: `useModels({ backend, agent })` (grouped + flattened options, `find`, `defaultModel`), `useAgents({ backend })`; `AgentBackend.listModels?` / `listAgents?` (and `AgentClient` methods); `useAgentChat({ model })` sends it with every turn; `chat.setThreadModel(id | null)`; `ThreadPatch.model`.
  - codegen: `GET /agent/models` as `agent.models.list`; thread summaries carry `defaultAgent`/`activeRunId`/`model`; the thread PATCH body takes `title?`/`defaultAgent?`/`model?`.

## 0.7.0

### Minor Changes

- [#211](https://github.com/DavideCarvalho/nestjs-agent/pull/211) [`75eb415`](https://github.com/DavideCarvalho/nestjs-agent/commit/75eb415c98cde1ba3fdd8d0366774c5d7514bfdf) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Pluggable chat backend, resumable streams, message feedback and a thread-list hook.

  - react: `AgentBackend` — the interface every hook talks to (stream start/resume, cancel, thread CRUD required; fork/promote/truncate, approvals, answers, upload, tools, skills, quota, feedback optional). `AgentClient` implements it (new `openChatStream`, `resumeChatStream`, `setMessageFeedback`); `useAgentChat({ backend })` and `AgentChatTransport({ backend })` accept your own (a generated client, cookie session + CSRF). `useAgentChat` is generic over the backend and returns it as `backend` (and `client`), plus `getThreadId()` and `connection`. A missing optional member throws `AgentBackendUnsupportedError`.
  - react: the transport reconnects a dropped, numbered stream from its last frame (`?after=<seq>`) with exponential backoff (`reconnect: { maxAttempts, baseDelayMs, maxDelayMs } | false`); `status` reads `'reconnecting'` meanwhile (`ChatStatus` gains it; the transcript treats it as streaming). A run that ended while away reloads the thread.
  - react: headless `useThreads({ backend })` (list, optimistic rename/remove, refreshed when a chat on the same backend creates a thread, settles a run or streams a title) and `useMessageFeedback({ backend, threadId })`. Live messages carry `metadata.runId`; replayed ones `metadata.feedback` (`AgentMessageMetadata`). `useToolCatalog`/`createSkillsSource` accept any backend with `listTools`/`listSkills`.
  - nestjs: every event frame carries an SSE `id:` (1-based, stable across attaches); `GET chat/:runId/stream` honours `?after=` and `Last-Event-ID`. New `POST messages/:id/feedback` (`MessagesController`, `AgentService.setMessageFeedback`).
  - core: `StoredMessage.feedback`, `MessageFeedback`; optional `AgentStore.threadOfMessage` / `setMessageFeedback`.
  - store-drizzle / store-mikro-orm: `agent_message.feedback` (json, nullable; added by `ensureAgentSchema`, not copied on fork). testing: `InMemoryAgentStore` implements both.
  - codegen: `POST /agent/messages/:id/feedback` as `agent.messages.feedback`; `feedback` on stored messages.

## 0.6.0

### Minor Changes

- [#199](https://github.com/DavideCarvalho/nestjs-agent/pull/199) [`b6edbab`](https://github.com/DavideCarvalho/nestjs-agent/commit/b6edbab8897179a87dce50e6ac45f90b91f4b91f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Tool presentation declared on the server, and a headless tool-activity model on the client.

  - core: `ToolPresentation` (`label`, `running`/`done` templates over the call's input, `icon`, `detail`, `tone`, `confirm: { title, verb, detail? }`, `result` view over the output), `ToolResultView` (`metrics` / `table` / `log` / `note` / `elsewhere`), `ToolCatalogEntry`; `ToolSpec.presentation` (never shown to the model); `ToolRegistry.visibleSpecs` — whole specs behind the same gates as `definitionsFor`.
  - nestjs: `@AiTool({ presentation })`; `GET /agent/tools?agent=` returns `ToolCatalogEntry[]` for the tools the caller can reach through that agent (default agent when omitted, `404` for an unknown one).
  - react: `AgentClient.listTools`, `useToolCatalog({ client, agent? })` (one shared request per client + agent), `phraseFor` / `fillTemplate` / `readPath` / `toolCatalogFrom`, `resolveResultView` / `inferResultView`, `toolCallState` / `correctedCallIds` / `isActionCall` / `describeToolCall`, and `groupToolActivity` (group by label or any key, counts, worst status, nested-call counts or expansion, corrected-failure hiding). `useChatTranscript({ toolCatalog })` gives every tool call a `description` and every tool block an `activity` grouping.
  - codegen: `GET /agent/tools` in the generated client; `StoredMessage` mirror gains `reasoning`, `reasoningMs`, `ui`.

## 0.5.0

### Minor Changes

- [#114](https://github.com/DavideCarvalho/nestjs-agent/pull/114) [`a7b848a`](https://github.com/DavideCarvalho/nestjs-agent/commit/a7b848a53e696f03ab0b8539260f7b51b019ff3b) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Six JSON routes the library serves were missing from the generated client, so every host using
  codegen had no typed way to call them: `GET /agent/skills`, `GET /agent/memories`, `DELETE
/agent/memories/:id`, `POST /agent/tool-call/answer`, `POST /agent/tool-call/skip` and `GET
/agent/attachments`. Their siblings were all there, which is what made the gap invisible — a
  frontend reaching for `api.agent.skills.list()` found nothing and had no reason to suspect the
  endpoint existed.

  The list is hand-written against controllers this package deliberately does not import, so it can
  only drift. `covers-every-json-route.spec.ts` now reads those controllers off disk and fails when a
  route is in neither the injected list nor an explicit not-modelled list. Three routes are on that
  list, each for a reason codegen cannot express: the two SSE chat endpoints, and the multipart
  `POST /agent/attachments`.

## 0.4.0

### Minor Changes

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Every package's specs are typechecked now, and two published signatures were wrong.

  `typecheck` compiles each package's sources with `*.spec.ts` excluded; `typecheck:specs` compiles
  them with the specs included. Ten of the seventeen packages had no `typecheck:specs` at all, so
  their specs had never been typechecked — 372 errors were waiting in them, and behind those errors
  sat fakes that did not implement what they claimed and calls that named options and parameters
  nothing accepts.

  Two of the findings are in shipped code, not in the tests:

  - `nestjsAgentCodegen()` declared its return as the bare `CodegenExtension`, whose `transformRoutes`
    is optional, takes an `ExtensionContext`, and may return a promise or nothing. The extension
    always defines it, runs synchronously and reads no context, so every caller holding the result had
    to widen or cast to use it. It returns the new `AgentCodegenExtension` instead, which says so.
  - `LedgerQuotaStore.bump()` declared no parameters. It is a deliberate no-op — the ledger already
    holds the turn's tokens — but `QuotaStore.bump` takes `(actorRef, day, tokens)`, and a shorter
    function is assignable to a longer one, so the arity mismatch only showed up for a caller holding
    the concrete class. It now declares the parameters it ignores.

  Worth naming among the spec-side findings, because each is a check that was not happening:

  - Nine durable/runner module setups omitted `AgentModuleOptions.actorResolver`, which is required
    precisely so that no deployment can forget it.
  - Two `waitForRun` calls asked for `until: 'suspended'`, which is not one of the two states that
    option has. The engine treats anything but `'terminal'` as `'settled'`, so they were already
    waiting for what they meant.
  - The `@Agent` fixture typed `Required<AgentOptions>` — there to stop compiling when an option is
    added and forgotten — carried an `intake` that was not an `AgentIntake`, so the one field it was
    guarding was never guarded.
  - Two agent-loop fakes were built by spreading a class instance, which copies no prototype method;
    neither was the `AgentStore` its annotation claimed.
  - The React `fetch` fakes returned `Response`-shaped object literals behind `as unknown as typeof
fetch`, so neither the fakes nor the recorded call tuples were checked against `fetch` at all.

  `packages/core` is the case that needed a decision rather than a fix: its specs use
  `@dudousxd/nestjs-agent-testing`, which depends on core, so declaring it would close a
  core → testing → core cycle in `build`. Its spec project resolves both packages to their TypeScript
  sources instead — exactly what Vitest's own alias already does — so the typechecker sees what the
  tests execute and no package graph edge is added.

## 0.3.1

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
