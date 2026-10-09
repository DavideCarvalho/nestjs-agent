# @dudousxd/nestjs-agent-ai-sdk

## 0.10.0

### Minor Changes

- [#342](https://github.com/DavideCarvalho/nestjs-agent/pull/342) [`4ee64b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/4ee64b0953c2dc94f0cfbd681987e2838172518b) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Cost works out of the box for OpenRouter, and an unpriced model can no longer go silently null.

  - **OpenRouter cost is read.** `aiSdkModel` read `total_cost`, which `@openrouter/ai-sdk-provider` never emits, so every OpenRouter turn recorded a `null` cost. It now reads `providerMetadata.openrouter.usage.cost` (the real, per-call routed cost), keeping `total_cost` as a fallback.
  - **Usage accounting is requested.** `aiSdkModel` / `aiSdkModels` add `providerOptions.openrouter.usage = { include: true }` to OpenRouter calls (your own `openrouter.usage` wins) and warn once per model when an OpenRouter call still returns no cost. `AiSdkModelOptions` gains a typed `providerOptions`.
  - **Boot seeds missing prices from models.dev.** New optional `ModelProvider.describeModels()` (implemented by `aiSdkModel` / `aiSdkModels`). On application bootstrap `AgentModule` writes the models.dev list price for any configured model the bound `AGENT_PRICING_STORE` has no row for — never overwriting one — and warns once about a model that would record no cost. New `priceCatalog` option (`{ url, fetch }` or `false`); skipped under `NODE_ENV=test` unless set. Core exports `ensureModelPricing`, `lookupModelsDevPrices`, `modelsDevRefsFor`, `seedPricesFromModelsDev`.

## 0.9.1

### Patch Changes

- [#338](https://github.com/DavideCarvalho/nestjs-agent/pull/338) [`6630829`](https://github.com/DavideCarvalho/nestjs-agent/commit/6630829df0f8ccc34310d7db125270d4984f12cd) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - An empty assistant message no longer poisons a thread. When the model ended a step with no text (Claude does this right after a tool whose result is the answer, such as `renderResult`), the loop stored an assistant message with empty content and replayed it on the next turn. Anthropic and Bedrock refuse the whole request for it ("The content field in the Message object at messages.N is empty"), so every later message on that thread failed.

  - The loop no longer stores a step that has no text and nothing else on it (no tool call, pushed UI, reasoning or follow-ups). A tool-call-only assistant message is still stored and replayed as before. The `persist:assistant:<step>` checkpoint stays (it records `null`), so runs in flight replay unchanged.
  - History building drops every assistant message whose text is empty or whitespace-only and that has no tool calls or results, so a thread that already stored one heals on its next turn.
  - `aiSdkModel` never sends an empty assistant message or a whitespace-only text part next to tool calls.
  - The follow-up prompt and a detached run's delivery skip a blank answer too.
  - `@dudousxd/nestjs-agent-testing` exports `BLANK_ASSISTANT_HISTORY_CONTRACT`, run by both SQL stores' real-database suites.

## 0.9.0

### Minor Changes

- [#267](https://github.com/DavideCarvalho/nestjs-agent/pull/267) [`43fa891`](https://github.com/DavideCarvalho/nestjs-agent/commit/43fa891a5a48bcf2130d01c4952b7b767d5dd502) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Confirmed writes — preview, signed single-use `confirmToken`, commit (port of adonis-agora-agent#233).

  `defineConfirmedTool(options, { prepare, preview, commit })` returns a functional tool whose human gate lives inside it, so the same write serves the chat loop and MCP (where an `action` tool has no approval channel): a call without `confirm` validates and previews without writing and returns a `confirmToken`; the same arguments plus `confirm: true` and the token commit. The token is an HMAC over the tool, actor, tenant, expiry and canonical arguments. A `ConfirmTokenStore` makes it single use — claimed right before `commit`, released if `commit` throws.

  - core: `defineConfirmedTool`, `withConfirmFields`, `ConfirmTokenError`, `signConfirmToken` / `verifyConfirmToken` / `hashConfirmToken` / `canonicalJson`, the `ConfirmTokenStore` SPI, `InMemoryConfirmTokenStore`, `AGENT_CONFIRM_TOKEN_STORE`, and `SchemaExtension` / `schemaExtensionOf` (a schema that is another schema plus a few JSON properties).
  - ai-sdk, mcp-server: a `SchemaExtension` schema is converted through its inner schema, so a Zod 3 tool wrapped by `withConfirmFields` shows the model its real shape plus `confirm` / `confirmToken`.
  - store-drizzle, store-mikro-orm: `DrizzleConfirmTokenStore` / `MikroOrmConfirmTokenStore` on a new `agent_confirm_token` table (created by `ensureAgentSchema`; MikroORM: also in `agentEntities()` / `agentManagedTables()`), bound to `AGENT_CONFIRM_TOKEN_STORE` by the store modules.
  - testing: `CONFIRM_TOKEN_STORE_CONTRACT`, the cases every store runs.

## 0.8.1

### Patch Changes

- [#250](https://github.com/DavideCarvalho/nestjs-agent/pull/250) [`3c9cb61`](https://github.com/DavideCarvalho/nestjs-agent/commit/3c9cb617a4ca911b201f224f148c34a345a3f573) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A turn that dies mid-step no longer takes its thread with it.

  A turn writes its tool results onto the assistant message once the step's last tool has settled. A
  run that died before that — refused a checkpoint position, failed while settling a tool — left an
  assistant message asking for tools and answered by nothing, and (on a replay refusal) a run row
  still `running` and a thread still pointed at the run. The next message on the same thread was then
  sent to the provider with a tool call and no result after it, and failed with the AI SDK's "No
  output generated. Check the stream for errors." — every time, for the rest of the conversation.

  - **History is settled before it is sent.** Reading the thread for a turn now answers every tool
    call its message holds no result for: with what the call's own row says where the store can read
    it (`AgentStore.toolCallOutcomes`, optional, implemented by the in-memory, Drizzle and MikroORM
    stores) — a tool that DID run hands the model its real output, so it is not run a second time —
    and otherwise with a result saying the call was never completed. Done inside `load:thread`, so it
    takes no checkpoint position and a replay composes the same prompt. `settleDanglingToolCalls` /
    `danglingToolCallIds` are exported from core.
  - **A run that ends without settling leaves nothing waiting on it.** A failing run settles the calls
    it had put to a person as `failed` (`AgentStore.failUnsettledToolCalls`, optional, same three
    stores). A run refused a checkpoint position — which cannot write a checkpoint — settles its row,
    its calls and its thread straight to the store (`settleDeadRun`); before, it did none of the
    three. A send that finds its thread held by a run that is gone settles that run's calls too.
  - **A decision for a run that is over is refused**, not swallowed: `approve` / `reject` / `answer` /
    `skip` throw `RunNotActiveException` (`409 { code: 'run_not_active' }`) instead of signalling a
    run that will never read it — the card no longer says "approved" for something that will not run.
  - **The error frame is written for the person reading the chat.** It carries a stable `code`
    (`run_failed`, plus the new `replay_diverged` and `model_no_output`) and, in production,
    `RUN_FAILED_MESSAGE` instead of the error's own text; the error is logged with its run id and
    stays on the run row. Outside production the raw message still rides the frame;
    `exposeStreamErrorDetails(true | false)` decides it outright. Messages the library words itself
    (`quota_exceeded`, `output_rejected`, `structured_output_invalid`) are unchanged. A client that
    matched on the raw text of a `run_failed` message in production must switch to the `code`.
  - **`aiSdkModel` throws the provider's own error** when the stream carries one, instead of letting
    it surface as "No output generated".
  - **React (headless).** `chat.runError` is the failed run's `{ code, message, runId? }` until the
    next attempt starts, and the transport takes `onRunError`; `isRunNotActiveError(error)` recognises
    the 409 on a decision, and the transcript model carries it as `call.errorCode` /
    `elicitation.errorCode` next to `error`. `AGENT_RUN_ERROR_CODES` lists the codes. Nothing is rendered: the app words
    each code itself.
  - **A tool is handed an idempotency key.** `ctx.idempotencyKey` is `<runId>:<toolCallId>` — the same
    for every execution of one call — and `ctx.toolCallId` names the call. A worker that dies between
    a tool's side effect and the checkpoint that records it re-runs the tool on recovery; passing the
    key on to whatever the tool writes to is what makes the second attempt land on the first.

## 0.8.0

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

## 0.7.0

### Minor Changes

- [#213](https://github.com/DavideCarvalho/nestjs-agent/pull/213) [`a4dc582`](https://github.com/DavideCarvalho/nestjs-agent/commit/a4dc5823eea59e971404a53b4d7ce0fc7cda88b6) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Model catalog, per-thread and per-send model selection, model/agent picker hooks.

  - core: `ModelCatalog` SPI (`list({ actor, agent }) → { providers: [{ id, label, models: [{ id, label, description?, badges?, available, unavailableReason?, contextWindow? }] }], default }`), `staticModelCatalog`, `findCatalogModel`, `withSelectedModel`, `AGENT_MODEL_CATALOG`. `ModelTurnArgs.model`, `AgentRunInput.model`, `LlmStepEnvelope.model`, `ThreadSummary.model`, `UpdateThreadInput.model`. A turn with a selected model runs every call (answer, structured output, follow-ups, dispatched steps) on it and labels usage with it when the provider reports no model id.
  - nestjs: `AgentModule.forRoot({ models })`; `GET models?agent=` (`ModelsController`; empty catalog when none is bound); `POST chat { model }`; `PATCH threads/:id { model }` (`null` unpins). A model is refused with 400 unless the catalog lists it as available for the actor and agent — checked when pinned and again on every turn. Thread reads normalize `model` to `null`.
  - ai-sdk: `aiSdkModel(model, { resolveModel })` runs the picked id; without a resolver a gateway string id is swapped for the pick and a provider instance ignores it.
  - store-drizzle / store-mikro-orm / testing: `agent_thread.model` (nullable, added by `ensureAgentSchema`, copied on fork), `modelForThread`.
  - react: `useModels({ backend, agent })` (grouped + flattened options, `find`, `defaultModel`), `useAgents({ backend })`; `AgentBackend.listModels?` / `listAgents?` (and `AgentClient` methods); `useAgentChat({ model })` sends it with every turn; `chat.setThreadModel(id | null)`; `ThreadPatch.model`.
  - codegen: `GET /agent/models` as `agent.models.list`; thread summaries carry `defaultAgent`/`activeRunId`/`model`; the thread PATCH body takes `title?`/`defaultAgent?`/`model?`.

## 0.6.0

### Minor Changes

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Constrain a turn's answer to a schema.

  Every answer this library produced was free text, so the only way to get a typed value back out of a
  turn was to declare a TOOL whose whole job was to receive it — which is how the main consumer ended
  up with a `renderResult` tool that renders nothing and exists purely to smuggle structure past the
  prose.

  `@Agent({ outputSchema })` takes any [Standard Schema](https://standardschema.dev) (Zod, Valibot,
  ArkType). The validated value comes back as `object` on the run's result, typed when the loop is
  called directly (`runAgentLoop<T>`), and is recorded on the assistant message as a synthetic
  `structured_output` tool call — the device inject-mode retrieval already uses, so it reaches every
  thread reader and the UI's existing tool-output rendering without a store gaining a column. It is
  declared on the agent rather than per request because a schema is a live object and `AgentRunInput`
  crosses a JSON boundary on its way into a durable workflow.

  **How it composes with tool calling: as a separate formatting pass, always.** The turn runs its
  model→tools iteration exactly as it would without a schema; once a step comes back with no tool
  calls, one extra non-streamed call (`structured:<step>:<n>`, `tools: []`, `outputSchema` set)
  restates that answer as the schema. Most providers cannot serve a response format and a tool set in
  the same request. Skipping the pass for an agent that happens to have no tools would be cheaper and
  is deliberately not done: that decision would read the tool registry of whichever process is
  replaying, which is how a resumed run ends up asking for a checkpoint position its history has no
  room for. So the pass is unconditional, and it costs one model call per turn, billed as its own
  `structured_output` usage row.

  The pass restates the answer that survived the output gate, never the model's raw reply, and is told
  to use only what the conversation already contains — the structured value is a translation of the
  answer, not a second route out of the model.

  **An answer that fails the schema is a defined outcome.** Up to `outputRepairAttempts` further calls
  (default 1) re-ask with the previous attempt's validation issues attached; after that the run fails
  with a `StructuredOutputError` carrying the issues, the text that failed them, and the attempt count,
  under its own `structured_output_invalid` stream error code. Bounded because a model that cannot
  satisfy a schema usually cannot satisfy it on the fourth try either, and every attempt is billed. Set
  `outputRepairAttempts: 0` to fail on the first invalid reply.

  `ModelTurnArgs` gains `outputSchema` and `ModelTurnResult` gains `object`. The AI SDK adapter maps
  the schema onto `streamText`'s `output: Output.object(...)` so the provider constrains generation,
  and passes its parsed value back — but the loop validates it regardless. "The provider says it
  matched" is not the same claim as "it matches", and a provider that ignored the schema has to fail
  where the failure is repairable rather than downstream. An adapter that cannot constrain generation
  at all still works: the loop reads the JSON out of the reply text, fences and lead-in prose included.

  `UsagePurpose` gains `'structured_output'`. Both shipped stores persist `purpose` as text, so no
  schema change is needed. A consumer who declares no `outputSchema` sees no new checkpoint, no extra
  call, and no change to the loop's checkpoint sequence.

## 0.5.3

### Patch Changes

- [#59](https://github.com/DavideCarvalho/nestjs-agent/pull/59) [`d115cb7`](https://github.com/DavideCarvalho/nestjs-agent/commit/d115cb7973aafa539eafbb1e488259044a562069) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Stop a `core` minor from promoting half the monorepo to 1.0.0.

  Five packages declared their peer dependency on `@dudousxd/nestjs-agent-core` as `workspace:*`. Changesets treats a peer-dependency bump as breaking for the dependent, and "breaking" on a `0.x` package means `1.0.0` — so the moment `core` took a minor, `ai-sdk`, `rag`, `store-mikro-orm`, `testing` and `transport-redis` were all queued to publish as `1.0.0`. `rag-media` went with them by cascade: its own range on `core` was correct, but its `>=0.4.0 <1.0.0` on `rag` stopped being satisfied once `rag` majored.

  The ranges are now `>=0.10.0 <1.0.0`, matching what `dashboard` and `rag-media` already declared. `onlyUpdatePeerDependentsWhenOutOfRange` is already set in the changesets config, and with a range that a `0.11.0` core still satisfies it does its job. `dashboard` is the control: it peer-depends on `core` too, and it was the one package that did _not_ major, because its range was written this way from the start.

  Verified by running `changeset version` against the same set of changesets before and after: six `1.0.0` bumps become the minors and patches those changesets actually asked for.

  Consumers would have felt this as silence rather than breakage. A dependant on `^0.7.0` of `rag` does not match `1.0.0`, so it simply stops receiving updates, with nothing failing anywhere to say so.

## 0.5.2

### Patch Changes

- Updated dependencies [[`70114eb`](https://github.com/DavideCarvalho/nestjs-agent/commit/70114ebb9a7a3702d2efdb11e0dea6956a7ba8db)]:
  - @dudousxd/nestjs-agent-core@0.10.0

## 0.5.1

### Patch Changes

- Updated dependencies [[`107fcc2`](https://github.com/DavideCarvalho/nestjs-agent/commit/107fcc2c0079f97c3cc9ff8c83f2dc41070244d5)]:
  - @dudousxd/nestjs-agent-core@0.9.0

## 0.5.0

### Minor Changes

- [`3d256d4`](https://github.com/DavideCarvalho/nestjs-agent/commit/3d256d4027c7ad819f8ec908425d52887e67da3f) - `attachmentFetchDownloader()` — the ready-made `experimental_download` for hosts whose attachment
  staging presigns non-public URLs (local MinIO in dev, VPC-only S3): plain-fetches unsupported URLs
  with no hostname policy, leaves model-supported URLs to the provider, errors carry status +
  hostname (never the full presigned URL). One line instead of the fetch boilerplate every such host
  was about to copy. Safe only because agent attachment URLs come from the host's own staging SPI.

### Patch Changes

- Updated dependencies [[`3d256d4`](https://github.com/DavideCarvalho/nestjs-agent/commit/3d256d4027c7ad819f8ec908425d52887e67da3f)]:
  - @dudousxd/nestjs-agent-core@0.8.0

## 0.4.3

### Patch Changes

- [`6263338`](https://github.com/DavideCarvalho/nestjs-agent/commit/6263338cf86df7b51cb082d5d2d575987cd13383) - `AiSdkModelOptions` accepts `experimental_download` — the AI SDK's default downloader refuses
  localhost/private hostnames (SSRF guard), so attachment parts staged against a local object store
  (MinIO in dev) killed the model call with `AI_DownloadError: URL with hostname localhost is not
allowed`. Hosts whose staging presigns non-public URLs supply their own fetch; attachment URLs come
  from the host's own staging SPI, never user input.
- Updated dependencies [[`6263338`](https://github.com/DavideCarvalho/nestjs-agent/commit/6263338cf86df7b51cb082d5d2d575987cd13383)]:
  - @dudousxd/nestjs-agent-core@0.7.0

## 0.4.2

### Patch Changes

- Updated dependencies [[`eb3aaff`](https://github.com/DavideCarvalho/nestjs-agent/commit/eb3aaff531cc923de1d0bccebb2b0690b4c92263), [`781a30f`](https://github.com/DavideCarvalho/nestjs-agent/commit/781a30f6579d5b9a69f341b8eeac02c273dbb8a1)]:
  - @dudousxd/nestjs-agent-core@0.6.0

## 0.4.1

### Patch Changes

- Updated dependencies [[`1c44152`](https://github.com/DavideCarvalho/nestjs-agent/commit/1c4415295a6280527e762f13e6aed48099ae5ca5), [`1c44152`](https://github.com/DavideCarvalho/nestjs-agent/commit/1c4415295a6280527e762f13e6aed48099ae5ca5)]:
  - @dudousxd/nestjs-agent-core@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [[`abb32bc`](https://github.com/DavideCarvalho/nestjs-agent/commit/abb32bc0396c65a59ee2b92a1a8b07d772215e31)]:
  - @dudousxd/nestjs-agent-core@0.4.0

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

- Updated dependencies [[`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46), [`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46), [`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46)]:
  - @dudousxd/nestjs-agent-core@0.3.3

## 0.3.2

### Patch Changes

- Updated dependencies
- Updated dependencies [ad8e446]
  - @dudousxd/nestjs-agent-core@0.3.2

## 0.3.1

### Patch Changes

- Updated dependencies [[`60dcc7d`](https://github.com/DavideCarvalho/nestjs-agent/commit/60dcc7db3764a7d60cb6e4d586f1c0fe7b05ee04)]:
  - @dudousxd/nestjs-agent-core@0.3.1
