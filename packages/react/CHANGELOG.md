# @dudousxd/nestjs-agent-react

## 0.35.1

### Patch Changes

- Updated dependencies [[`80630c6`](https://github.com/DavideCarvalho/nestjs-agent/commit/80630c660568a6d57c68effc50abdf85a1da8501)]:
  - @dudousxd/nestjs-agent-core@0.45.1

## 0.35.0

### Minor Changes

- [#334](https://github.com/DavideCarvalho/nestjs-agent/pull/334) [`141715c`](https://github.com/DavideCarvalho/nestjs-agent/commit/141715cbba01263f28719edce62829a6b75d75d0) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Generative UI: draw a `ui__render` tree while the model writes it.

  - **`streaming: 'partial'`** (tree mode, on `genuiTools` and `AgentGenuiModule`). The server parses the streaming `ui__render` arguments and pushes the tree so far as `ui` frames marked `partial: true`, under the id the final push replaces (`<toolCallId>:ui:0`). Previews are throttled (`streamingThrottleMs`, default 100 ms, and only when changed), never validated, never persisted, carry no `fallbackText` and are skipped by text channels; a turn whose client cannot draw the tree gets none. Only the final tree goes through the catalog; a preview the call does not replace (an invalid tree, a text fallback) is withdrawn with a partial frame whose `props` are `{}`. The previews a step showed ride its journaled result (inline, and the durable runner's dispatched llm step), so a replay withdraws the same ones. AG-UI sends the previews as repeated `agora.ui` events with the same id. The default stays `streaming: 'complete'`, since renderers written for validated props would otherwise receive half-written ones. Wire format identical to `@adonis-agora/agent`'s.
  - **Per component:** `defineComponent({ …, streaming: 'complete' })` holds a component back while its subtree is written — the node is a `{ held: true, props: {} }` placeholder until it closes — and `streaming: 'partial'` opts one in.
  - **Stable nodes:** every node of a partial tree carries its position as `id` (`root`, `root.0`, …), the same rule that names the final tree's nodes, and `incomplete: true` while it is being written.
  - **React:** `<GenerativeUI>` renders partial trees without remounting nodes, skips prop validation for incomplete nodes, exposes `useGenuiNode()` (`{ id, type, incomplete, held }`) for skeletons, and draws `placeholder` (new prop on `<GenerativeUI>` / `<GenuiProvider>` / `genui` on `<AgentProvider>`, default `loading`) for held nodes. The transport carries `partial` on the `data-ui` part; the transcript drops withdrawn previews and those whose call settled without replacing them; a json-render spec leaves held nodes out.
  - **Tool SPI:** `ToolHandler.previewInput(scope)` lets any tool preview its streaming input (`ToolRegistry.previewInput`, `previewToolInputs`, `registryInputPreviews`); `parsePartialJson` is exported. `AgentUiComponent.partial` joins the stream vocabulary.
  - **Channels:** a text channel never sends a preview, only the final component or its fallback text.

### Patch Changes

- Updated dependencies [[`141715c`](https://github.com/DavideCarvalho/nestjs-agent/commit/141715cbba01263f28719edce62829a6b75d75d0), [`141715c`](https://github.com/DavideCarvalho/nestjs-agent/commit/141715cbba01263f28719edce62829a6b75d75d0), [`141715c`](https://github.com/DavideCarvalho/nestjs-agent/commit/141715cbba01263f28719edce62829a6b75d75d0)]:
  - @dudousxd/nestjs-agent-core@0.45.0

## 0.34.5

### Patch Changes

- Updated dependencies [[`bb635d1`](https://github.com/DavideCarvalho/nestjs-agent/commit/bb635d19a7763024c13421f90aa21ca12c8fe58b)]:
  - @dudousxd/nestjs-agent-core@0.44.1

## 0.34.4

### Patch Changes

- Updated dependencies [[`754b0d0`](https://github.com/DavideCarvalho/nestjs-agent/commit/754b0d00c8631a88763539958e6fe11823d81a3c)]:
  - @dudousxd/nestjs-agent-core@0.44.0

## 0.34.3

### Patch Changes

- Updated dependencies [[`a4a098c`](https://github.com/DavideCarvalho/nestjs-agent/commit/a4a098c61b3246bce716a124b3fa3372b1af6cf5)]:
  - @dudousxd/nestjs-agent-core@0.43.0

## 0.34.2

### Patch Changes

- [#324](https://github.com/DavideCarvalho/nestjs-agent/pull/324) [`d516616`](https://github.com/DavideCarvalho/nestjs-agent/commit/d51661667fe477f11c2cca25483ded3678d53f96) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - AG-UI from React follows the run past an approval or a question, like the native stream.

  - `POST <path>/ag-ui` writes the run's own sequence number as each event's SSE `id:` (`agUiEvents({ cursor })`, `agUiSse(event, id)`, `frameSeq`), so a consumer can continue on `chat/:runId/stream?after=<id>` exactly where the AG-UI run ended.
  - `agUiChatStream`: an interrupt the chat already shows (approval card, question form) ends the stream without `done`, so the transport re-attaches to the parked run on the native route and what the run does after the person decides streams into the same message. The re-attach cursor is the run's own sequence (before, the client numbered re-framed frames itself, so `?after=` pointed at the wrong frame).
  - The `AgUiInterrupt` ui part is written only for interrupts nothing in the stream showed.
  - `agora.action-proposal-decision` becomes the transient `data-proposal-decision` part a native text decision answers with.

- [#324](https://github.com/DavideCarvalho/nestjs-agent/pull/324) [`d516616`](https://github.com/DavideCarvalho/nestjs-agent/commit/d51661667fe477f11c2cca25483ded3678d53f96) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - AG-UI: a React app on `agUiChatStream` now gets what the native stream gives it.

  - Attachments: the send's staged `attachments` (`{ mediaId }`) go out as `file` content parts with `provider: 'nestjs-agent'` (`AG_UI_MEDIA_PROVIDER`); `POST <path>/ag-ui` resolves them for the caller exactly like the native `chat` route (a mediaId another actor owns is refused with 403). Before, the composer's attachments were silently dropped.
  - Regenerate: `regenerate: true` rides `forwardedProps` and the route re-runs the thread's last exchange instead of appending a new turn (400 on a thread that does not exist yet).
  - Question sets: `agora.elicitation` now carries the tool-call `id`, and the React client turns it into the native `elicitation` frame, so the question form renders.
  - Per-step usage: `agora.step-usage` is folded into the preceding `step-finish` (`usage`, `costUsd`, `reasoningMs`) instead of being ignored.
  - Tool kinds: `TOOL_CALL_START.metadata` carries `agora.toolKind` (and `agora.parentId`); the React client uses them instead of marking every call `read`, so approval affordances and nested calls work over AG-UI.

- Updated dependencies [[`d516616`](https://github.com/DavideCarvalho/nestjs-agent/commit/d51661667fe477f11c2cca25483ded3678d53f96), [`d516616`](https://github.com/DavideCarvalho/nestjs-agent/commit/d51661667fe477f11c2cca25483ded3678d53f96), [`d516616`](https://github.com/DavideCarvalho/nestjs-agent/commit/d51661667fe477f11c2cca25483ded3678d53f96)]:
  - @dudousxd/nestjs-agent-core@0.42.1

## 0.34.1

### Patch Changes

- Updated dependencies [[`52703f0`](https://github.com/DavideCarvalho/nestjs-agent/commit/52703f077f5ae22ade28fbb5838d6591abcadc6e)]:
  - @dudousxd/nestjs-agent-core@0.42.0

## 0.34.0

### Minor Changes

- [#307](https://github.com/DavideCarvalho/nestjs-agent/pull/307) [`66305c4`](https://github.com/DavideCarvalho/nestjs-agent/commit/66305c47f0624ca3eafa0f9c298e40ad977ff064) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add an app-scoped React component registry, optional static HTML server rendering, and optional Playwright PNG/PDF capture with validated pagination, trusted app styles, isolated browser contexts, and bounded capture dimensions.

### Patch Changes

- [#319](https://github.com/DavideCarvalho/nestjs-agent/pull/319) [`6b7de84`](https://github.com/DavideCarvalho/nestjs-agent/commit/6b7de84eca7dd094baf21a19be8144d8ae2409da) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **Security:** proposal routes no longer return raw store rows. `GET /threads/:threadId/action-proposals`, the approve/reject routes, text decisions, the AG-UI decision event and the approval port all returned the stored row. That row includes the worker's execution lease token (which lets its holder settle the work), the delivery lease, the tool's `idempotencyKey`, and the execution address (`preparationInput`, `executionContext`). They now return `ActionProposalView` / `ActionProposalMutationView` (new in core, built with `toActionProposalView` / `toActionProposalMutationView`), which leave all of those out. `AgentApprovalPort`'s proposal methods and the React client's proposal types now use the view types. The codegen mirror no longer declares `idempotencyKey`.

- [#319](https://github.com/DavideCarvalho/nestjs-agent/pull/319) [`6b7de84`](https://github.com/DavideCarvalho/nestjs-agent/commit/6b7de84eca7dd094baf21a19be8144d8ae2409da) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `useAgentUiCapabilities` is now exported from the package root. It reads the `uiCapabilities` declared on the nearest `<AgentProvider>`.

- Updated dependencies [[`6b7de84`](https://github.com/DavideCarvalho/nestjs-agent/commit/6b7de84eca7dd094baf21a19be8144d8ae2409da), [`6b7de84`](https://github.com/DavideCarvalho/nestjs-agent/commit/6b7de84eca7dd094baf21a19be8144d8ae2409da), [`66305c4`](https://github.com/DavideCarvalho/nestjs-agent/commit/66305c47f0624ca3eafa0f9c298e40ad977ff064), [`6b7de84`](https://github.com/DavideCarvalho/nestjs-agent/commit/6b7de84eca7dd094baf21a19be8144d8ae2409da), [`6b7de84`](https://github.com/DavideCarvalho/nestjs-agent/commit/6b7de84eca7dd094baf21a19be8144d8ae2409da), [`6b7de84`](https://github.com/DavideCarvalho/nestjs-agent/commit/6b7de84eca7dd094baf21a19be8144d8ae2409da), [`6b7de84`](https://github.com/DavideCarvalho/nestjs-agent/commit/6b7de84eca7dd094baf21a19be8144d8ae2409da), [`6b7de84`](https://github.com/DavideCarvalho/nestjs-agent/commit/6b7de84eca7dd094baf21a19be8144d8ae2409da), [`6b7de84`](https://github.com/DavideCarvalho/nestjs-agent/commit/6b7de84eca7dd094baf21a19be8144d8ae2409da), [`6b7de84`](https://github.com/DavideCarvalho/nestjs-agent/commit/6b7de84eca7dd094baf21a19be8144d8ae2409da)]:
  - @dudousxd/nestjs-agent-core@0.41.0

## 0.33.0

### Minor Changes

- [#283](https://github.com/DavideCarvalho/nestjs-agent/pull/283) [`7136543`](https://github.com/DavideCarvalho/nestjs-agent/commit/71365431cd5afd16e937ab39bdcf886a71d7c5ae) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add read-only action preflight checks before approval and before execution, with ready, denied,
  and completed outcomes. Journal preparation and execution refusals so replay cannot change the
  approval branch or rerun a denied mutation. Direct registry and MCP invocation also checks state.

  Persist and stream per-call confirmation wording and render it through the existing React
  transcript. Add a nullable confirmation JSON column to both SQL stores.

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

- Updated dependencies [[`7136543`](https://github.com/DavideCarvalho/nestjs-agent/commit/71365431cd5afd16e937ab39bdcf886a71d7c5ae), [`cb8b15a`](https://github.com/DavideCarvalho/nestjs-agent/commit/cb8b15aa26bd5d7f68af40d41b4ddeba3d9b71dd), [`b233a41`](https://github.com/DavideCarvalho/nestjs-agent/commit/b233a418b411215e03e8bb02c32e13d685089f53), [`db48ea8`](https://github.com/DavideCarvalho/nestjs-agent/commit/db48ea8a7c281a111f4079a8e4ba9036244068c5), [`133975e`](https://github.com/DavideCarvalho/nestjs-agent/commit/133975e7b9aa9da44f708ce4a95940fb6f6440e4)]:
  - @dudousxd/nestjs-agent-core@0.40.0

## 0.32.0

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

### Patch Changes

- Updated dependencies [[`86afcb7`](https://github.com/DavideCarvalho/nestjs-agent/commit/86afcb75e11f4b676439c215885371c706389ab2)]:
  - @dudousxd/nestjs-agent-core@0.39.0

## 0.31.5

### Patch Changes

- Updated dependencies [[`dbd5592`](https://github.com/DavideCarvalho/nestjs-agent/commit/dbd55926dbda26d300d4a913173e7ad1182f4afc), [`dbd5592`](https://github.com/DavideCarvalho/nestjs-agent/commit/dbd55926dbda26d300d4a913173e7ad1182f4afc)]:
  - @dudousxd/nestjs-agent-core@0.38.1

## 0.31.4

### Patch Changes

- Updated dependencies [[`2e3ae25`](https://github.com/DavideCarvalho/nestjs-agent/commit/2e3ae254d33123ee589008a1711d10c7b7c3f0ee)]:
  - @dudousxd/nestjs-agent-core@0.38.0

## 0.31.3

### Patch Changes

- Updated dependencies [[`43fa891`](https://github.com/DavideCarvalho/nestjs-agent/commit/43fa891a5a48bcf2130d01c4952b7b767d5dd502)]:
  - @dudousxd/nestjs-agent-core@0.37.0

## 0.31.2

### Patch Changes

- Updated dependencies [[`3ed6542`](https://github.com/DavideCarvalho/nestjs-agent/commit/3ed654296e98ba93474c9edbf397ca10f1eb7c92)]:
  - @dudousxd/nestjs-agent-core@0.36.0

## 0.31.1

### Patch Changes

- Updated dependencies [[`754998a`](https://github.com/DavideCarvalho/nestjs-agent/commit/754998aee31b6e2325bf34371cd75806ef6a408b)]:
  - @dudousxd/nestjs-agent-core@0.35.0

## 0.31.0

### Minor Changes

- [#260](https://github.com/DavideCarvalho/nestjs-agent/pull/260) [`5ef81ca`](https://github.com/DavideCarvalho/nestjs-agent/commit/5ef81ca1ccb3a2168117efe0faf14f06e5810cbe) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `agUiChatStream`: AG-UI activity (`ACTIVITY_SNAPSHOT` / `ACTIVITY_DELTA`) arrives as a `ui` part `AgUiActivity` updated in place (the JSON Patch applied), and the `content` option sends a file with the message as AG-UI content parts.

## 0.30.0

### Minor Changes

- [#258](https://github.com/DavideCarvalho/nestjs-agent/pull/258) [`5ccecf9`](https://github.com/DavideCarvalho/nestjs-agent/commit/5ccecf9f558c8d7f782652d8c0b180f1b968969d) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `useAgentChat` can drive an AG-UI 1.0 agent: `agUiChatStream(request, { url })` behind `openChatStream` POSTs a `RunAgentInput` and re-frames the AG-UI answer in this library's stream protocol, so the transcript, tool activity and generative UI render unchanged. `reframeAgUiStream` is the re-framing alone.

## 0.29.2

### Patch Changes

- [#256](https://github.com/DavideCarvalho/nestjs-agent/pull/256) [`bf86406`](https://github.com/DavideCarvalho/nestjs-agent/commit/bf864065d8ec38e91350722feb9be0ce198467de) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Two things a reloaded chat got wrong. A tool call that failed — it threw, or its turn died before it was settled — reloaded as `output-available`, so an approval card drew an action that never ran as done; `storedMessageToUiMessage` now answers `output-error` with the stored reason, the state the live stream leaves it in. And `cancel()` did nothing on a run the chat had re-attached to after a reload: that stream opens with no `meta` frame, so the hook never learned the run's id — it now takes it from the attach (`AgentChatTransport`'s new `onResumeAttached`), which also makes `onRunSettled` fire for a re-attached run. `cancel()` also reads the thread's queue back when messages are waiting, so the pause a Stop puts on the queue shows at once instead of after the next reload.

## 0.29.1

### Patch Changes

- [#253](https://github.com/DavideCarvalho/nestjs-agent/pull/253) [`17c62f5`](https://github.com/DavideCarvalho/nestjs-agent/commit/17c62f56a023fafbabc3a0af59f43c77543ed242) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Stopping an answer no longer leaves an unhandled `AbortError` in the console. The chat's stop aborts the request, which errors the response body; the transport then cancelled that body and dropped the promise, which rejects with the same `AbortError: BodyStreamBuffer was aborted`.

## 0.29.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [[`3c9cb61`](https://github.com/DavideCarvalho/nestjs-agent/commit/3c9cb617a4ca911b201f224f148c34a345a3f573)]:
  - @dudousxd/nestjs-agent-core@0.34.0

## 0.28.0

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

### Patch Changes

- [#244](https://github.com/DavideCarvalho/nestjs-agent/pull/244) [`6cfebc7`](https://github.com/DavideCarvalho/nestjs-agent/commit/6cfebc785e9d0350864dedcba3a15ec928dd28b1) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix `ReferenceError: React is not defined` when mounting `AgentProvider`, `GenuiProvider`,
  `GenerativeUI`, `MessageList` or the json-render provider in an app with no global `React`.

  The build compiled JSX to `React.createElement(...)`, which only works in a module that binds
  `React` itself. The provider, `MessageList` and the generative-UI entries added in 0.24 (`.`,
  `/genui`, `/genui/json-render`) do not, so they reached for a global. The source was right
  (`jsx: react-jsx`); the build was not: the package inherited `emitDecoratorMetadata` from the repo's
  base tsconfig, which makes tsup compile through swc, and swc's JSX transform is the classic one
  whatever tsconfig says. The package now turns decorators off (it has none) and pins esbuild to the
  automatic runtime, so the output imports `jsx` from `react/jsx-runtime`.

  If you worked around it with `globalThis.React ??= React`, that line can go.

  So it cannot come back: CI (and the release script) now run `pnpm check:dist`, which fails on any
  built file in the repo that references `React.` without binding it, and loads every published entry
  of this package — ESM and CJS — in a process with no global `React`, rendering the providers and
  components.

- Updated dependencies [[`6cfebc7`](https://github.com/DavideCarvalho/nestjs-agent/commit/6cfebc785e9d0350864dedcba3a15ec928dd28b1)]:
  - @dudousxd/nestjs-agent-core@0.33.0

## 0.27.0

### Minor Changes

- [#241](https://github.com/DavideCarvalho/nestjs-agent/pull/241) [`68aee17`](https://github.com/DavideCarvalho/nestjs-agent/commit/68aee1787ea8a63279859ed99376849e1e8937b1) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Send while the agent is still answering: the message queue.

  - **Server.** `POST <base>/chat` on a thread with a turn running queues the message on the thread (persisted, per-thread FIFO) and answers `202 { queued: true, messageId, position, queue }` instead of starting a second, concurrent turn. When the turn settles the next queued message starts under its own id (inline and durable runners — the durable drain is journaled and spawned with `ctx.startChild`, so it never starts twice), announced as a final `queue` frame (`started: { messageId, runId }`) before the terminal. `mode: 'interrupt'` cancels the running turn and runs the message next; `mode: 'queue'` always queues. A failed turn or a Stop pauses the queue; an exhausted quota pauses it as the next message starts. New routes: `GET`/`DELETE threads/:id/queue`, `POST threads/:id/queue/resume`, `PATCH`/`DELETE queue/:messageId`; `GET threads/:id` carries `queue`. Admission is now a compare-and-set on the thread's active run (one turn per thread across pods; a stale holder left by a crashed process is replaced). `AgentService.send()` queues; `AgentService.chat()` stays start-or-refuse for in-process callers (`409 run_active` on a busy thread); `regenerate` on a busy thread is `409`.
  - **Core.** `ChatQueueStore` (probed by `isChatQueueStore`), `QueuedMessage`/`ChatQueueState`/`QueuePause`, the `queue` stream event, `ThreadDetail.queue`, `AgentRunner.start(input, { runId })` and the optional `isRunActive`. `InMemoryAgentStore` implements the queue.
  - **Stores.** Drizzle and MikroORM add `agent_queued_message` and `agent_thread.queue_pause` on boot (MikroORM: in `agentManagedTables()`); both implement `ChatQueueStore`.
  - **Testing.** `CHAT_QUEUE_STORE_CONTRACT` — framework-agnostic cases any `ChatQueueStore` can run.
  - **React.** `composer.submit()` / `sendMessage` mid-turn queue instead of being refused; `useAgentChat({ whileRunning: 'queue' | 'interrupt' | 'block' })`; `chat.queue` (`items`, `paused`, `add`, `remove`, `edit`, `move`, `clear`, `resume`, `error`); `chat.transcript.queued` renders waiting messages as pending user messages; the chat attaches to a queued turn when it starts, and starts a queue left waiting when the thread loads. `AgentBackend` gains the optional `enqueueMessage`, `getQueue`, `updateQueuedMessage`, `removeQueuedMessage`, `clearQueue`, `resumeQueue`; a `202` from `openChatStream` is reported as `queued`.
  - **Codegen.** The five queue routes, and `queue` on the thread detail.

### Patch Changes

- Updated dependencies [[`68aee17`](https://github.com/DavideCarvalho/nestjs-agent/commit/68aee1787ea8a63279859ed99376849e1e8937b1)]:
  - @dudousxd/nestjs-agent-core@0.32.0

## 0.26.0

### Minor Changes

- [#238](https://github.com/DavideCarvalho/nestjs-agent/pull/238) [`4c69aed`](https://github.com/DavideCarvalho/nestjs-agent/commit/4c69aedd3e4e81f32c08af5f3a52e7f9b561fced) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Gaps found moving flip-nestjs onto the React client:

  - `useAgentChat({ threadId })` reports `isLoadingHistory: true` from the very first render (and on the first render after a thread switch) until the history read settles, so a page shows its skeleton instead of flashing the empty state.
  - `GET <base>/tools?agent=*` answers every tool the actor reaches through any agent, each once; `useToolCatalog({ agent: ALL_AGENTS })` reads it (`ALL_AGENTS` from core and react).
  - `readOnly` on `useChatTranscript` / `useTranscriptItem` / `<MessageList>`: no approve / reject / answer / skip, edit, fork, regenerate or stop, whatever handlers or backend are in scope — parked approvals and question sets still render. Documents that decision handlers left undefined settle through the in-scope backend.

### Patch Changes

- Updated dependencies [[`4c69aed`](https://github.com/DavideCarvalho/nestjs-agent/commit/4c69aedd3e4e81f32c08af5f3a52e7f9b561fced)]:
  - @dudousxd/nestjs-agent-core@0.31.0

## 0.25.0

### Minor Changes

- [#236](https://github.com/DavideCarvalho/nestjs-agent/pull/236) [`9bf7efd`](https://github.com/DavideCarvalho/nestjs-agent/commit/9bf7efd574aabcceeebd9730ddbe5f2eaaae6822) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Chat protocol gaps found moving a sandboxed runner onto the React client:

  - **Error answers reach the hooks.** `AgentHttpError` (and `MediaUploadError`) carry the server's `code`, the parsed `body`, and its `message` as their own `message`, so a failed send, a refused upload or a refused approve/answer shows the server's words. `onHttpError` on `<AgentProvider>` / `AgentClient` sees every error answer before it is thrown (a resume's `404` excepted).
  - **A send's `model` is that turn's only.** `chat.models.select(id)` belongs to the conversation it was made in (switching threads drops it), `pinToThread(id)` replaces the pick, and `chat.models.pinned` is the thread's pin.
  - **Model lock.** `ModelCatalogView.locked: { model, reason? }` and `AgentCatalogEntry.lockedModel`; the server runs every turn of a locked agent on that model and refuses a send naming another. `useModels().locked` / `chat.models.locked`.
  - **Quota soft limit.** `QuotaWindow.warnAt`, `QuotaReport.warning: { period, ratio, reason? }`, `quotaWarning(windows)`, `quota: { limits, warnAt }` on the ledger provider, and `useQuota().warning` / `chat.quota.warning`. `QuotaWindow.usedTokens` is optional, for USD-only budgets.
  - **Who answered a question.** `answer`/`skip` take `via`; the settled outcome carries `answeredBy` / `answeredVia` (streamed, persisted, replayed), read into the elicitation block's `outcome`.
  - `docs/stream-protocol.md`: error bodies, the regenerate contract (`regenerate: true` never stores the user message again), and how a runner numbers a stream it rebuilds from checkpoints (ids only increase, gaps allowed).

### Patch Changes

- Updated dependencies [[`9bf7efd`](https://github.com/DavideCarvalho/nestjs-agent/commit/9bf7efd574aabcceeebd9730ddbe5f2eaaae6822)]:
  - @dudousxd/nestjs-agent-core@0.30.0

## 0.24.0

### Minor Changes

- [#234](https://github.com/DavideCarvalho/nestjs-agent/pull/234) [`39b6d0b`](https://github.com/DavideCarvalho/nestjs-agent/commit/39b6d0b56b3b165e2c685ba35192b3af2dcf6cfb) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Host message metadata and nested-call replay, for runners that are not this library's loop:

  - `StoredMessage.metadata` (host-defined, e.g. the model that answered or the error a turn ended with) is replayed into the client message's `metadata`, under the library's own keys.
  - A new `message-metadata` stream frame carries the same facts live and maps to the AI SDK's `message-metadata` chunk.
  - `ToolCallRequest.parentId` is replayed as the tool part's `toolMetadata.parentId`, so a reloaded thread nests code-mode inner calls the way the live stream did.
  - `useAgentChat({ agent })` is read at every send, so a host that switches agents before the first message (an agent picker on a new chat) sends the one picked now.
  - `chat.composer.submit()` puts the staged attachments on the sent user message as file parts (with their `mediaId`), so the bubble shows them before the thread is reloaded.
  - `chat.models.defaultModel`: the catalog default, for a picker that marks it.

### Patch Changes

- Updated dependencies [[`39b6d0b`](https://github.com/DavideCarvalho/nestjs-agent/commit/39b6d0b56b3b165e2c685ba35192b3af2dcf6cfb)]:
  - @dudousxd/nestjs-agent-core@0.29.0

## 0.23.0

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

### Patch Changes

- Updated dependencies [[`37e2c2d`](https://github.com/DavideCarvalho/nestjs-agent/commit/37e2c2de47b5ec36dc209a0f11678f3627a93fa6)]:
  - @dudousxd/nestjs-agent-core@0.28.0

## 0.22.1

### Patch Changes

- Updated dependencies [[`cd2c790`](https://github.com/DavideCarvalho/nestjs-agent/commit/cd2c7909df1c88cc914ec6aa28940800e0dcd705)]:
  - @dudousxd/nestjs-agent-core@0.27.0

## 0.22.0

### Minor Changes

- [#225](https://github.com/DavideCarvalho/nestjs-agent/pull/225) [`f909e85`](https://github.com/DavideCarvalho/nestjs-agent/commit/f909e857523181dd429e2d2a1d605f5b54756c21) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `useAgentChat` does the wiring: history, resume, quota, models, composer and a bound transcript.

  - A `threadId` without `initialMessages` loads the thread's history by itself (`history: false` opts out; `chat.isLoadingHistory` / `chat.historyError`), and changing `threadId` switches the chat to that thread cleanly. Passing back the thread the chat itself just created (URL sync) keeps the live conversation.
  - `resume` now defaults to `true`: a turn still streaming on the thread is re-attached (its already-persisted rows are left to the stream, so nothing is drawn twice).
  - Automatic quota gate: the chat reads `GET <base>/quota` when the backend implements `getQuota` (`quota: false` skips it) and refuses sends while a window is exhausted. `blocked` stays as an override (`null` never blocks). `chat.quota` is the `useQuota` state; `chat.blocked` the window blocking sends.
  - `chat.models`: `{ list, providers, selected, select(id), pinToThread(id), isLoading, error }`, loaded the first time `list`/`providers` is read. A pin asked for before the first send lands on the thread that send creates.
  - `chat.transcript`: `useChatTranscript` bound to the chat — approve/reject/answer/skip, stop, fork, regenerate, the tool catalog — overridable with `useAgentChat({ transcript: { … } })`.
  - `chat.composer`: `{ text, setText, files, canSend, blockedBy, submit() }` — attaches the ready files as refs, clears draft and files after sending, blocks while uploading / busy / quota-blocked. `useAgentChat({ composer: { accept, maxBytes, maxFiles } })`.
  - Approval and question-set blocks are functional by default: `useChatTranscript` (and so `MessageList`, the registry's `AgentChat`) settles them through the in-scope backend when no handler is passed; pass `null` to opt a decision out.
  - Messages carry `metadata.createdAt` (replayed rows and live turns) and replayed single rows their `metadata.usage`, which `useChatTranscript` reads by default for `timestamp` / `usage`.

  **Breaking**

  - Transcript callbacks take one object: `onApprove({ toolCallId, remember? })`, `onReject({ toolCallId, reason? })`, `onAnswer({ toolCallId, answers })`, `onSkip({ toolCallId })`, `onEditSubmit({ messageId, text })`, `onFork({ messageId })`, `onRegenerate({ messageId })` — the same shape as `chat.approve`/`reject`/`answer`/`skip`, so they can be passed straight through. Same for `MessageList` / `MessageItem` props (`MessageItem`'s `onEditSubmit` now gets `{ messageId, text }`, `onRegenerate` `{ messageId }`).
  - Removed from `useAgentChat`'s return: `threads`, `loadThreads`, `deleteThread`, `renameThread` (use `useThreads()`), `quota`/`loadQuota` v1 (`chat.quota` is now the `useQuota` state), `loadThread` (history loads itself; `chat.backend.getThread` for a manual read), `setThreadModel` (→ `chat.models.pinToThread`), `forkThread(threadId, messageId)` (→ `chat.fork({ messageId, threadId? })`), `truncateFromMessage(threadId, messageId)` (→ `chat.truncateFrom({ messageId, threadId? })`), `promoteThread(id)` (→ `chat.promote({ threadId? })`).
  - `resume` defaults to `true` (was `false`); `useAgentChat({ threadId })` now reads the thread on mount.
  - `AgentClient.getQuotaToday`, `AgentBackend.getQuotaToday` and the `QuotaToday` type are removed (use `getQuota` / `useQuota`); `AgentClient.renameThread` is removed (`updateThread(id, { title })`).
  - `storedMessageToUiMessage` / `storedThreadToUiMessages` now always stamp `metadata.createdAt` (and a single row's `usage`), so a replayed message is no longer metadata-free.

## 0.21.0

### Minor Changes

- [#223](https://github.com/DavideCarvalho/nestjs-agent/pull/223) [`2bacc34`](https://github.com/DavideCarvalho/nestjs-agent/commit/2bacc347be08a09f727ee6d9deeca41fc9250502) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `<AgentProvider>`: configure the agent connection once, and every hook uses it.

  - **New** `<AgentProvider baseUrl path headers getHeaders credentials fetch attachments={{ upload }} genui={{ registry, catalog, … }}>` (or `backend={yourBackend}`) and `useAgentBackend()`. `useAgentChat`, `useThreads`, `useModels`, `useAgents`, `useQuota`, `useToolCatalog`, `useMessageFeedback` and `useAttachments` all take `backend` optionally and fall back to the provider — and, with no provider, to one shared same-origin client on `/agent`. `useAgentChat()` is callable with no argument. `genui` sets up `<GenuiProvider>` in the same element (`GenuiProvider` stays as the standalone building block).
  - **New** `AgentClientOptions.path` (and `AgentChatTransportOptions.path`): the agent's route prefix, default `'agent'` — `baseUrl` is now just the origin. `AgentConnection` (handed to upload strategies) carries `path`.

  **Breaking**

  - `useAgentChat` no longer takes `baseUrl`, `headers`, `getHeaders`, `credentials`, `fetch`, `attachments` or `client` — put the connection on `<AgentProvider>` (or pass `backend: new AgentClient({ … })`). `chat.client` is gone; use `chat.backend`.
  - `AgentClientOptions.attachments` is now `{ upload }` (was the strategy itself): `new AgentClient({ attachments: { upload: mediaAttachments() } })`.
  - `useToolCatalog({ client })` → `useToolCatalog({ backend })` (optional); `createSkillsSource({ client })` → `createSkillsSource({ backend })`.
  - `/media`: `withMediaUploads` is removed (use `<AgentProvider attachments={{ upload: mediaAttachments() }}>`, or `createMediaUpload(connection)` as your backend's `uploadAttachment`); `mediaAttachments({ path })` is removed — the path comes from the client's `path`.
  - A `baseUrl` that included the agent prefix (`baseUrl: '/agent'`, which produced `/agent/agent/...`) must drop it: `baseUrl` is the origin, `path` the prefix.

## 0.20.0

### Minor Changes

- [#221](https://github.com/DavideCarvalho/nestjs-agent/pull/221) [`3b0fd1c`](https://github.com/DavideCarvalho/nestjs-agent/commit/3b0fd1c7f115f12f51d83bd3ada1c9e2b669f778) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Chat attachments on Aviary media, ready-made. `@dudousxd/nestjs-agent/media` adds
  `AgentMediaAttachmentsModule.forRoot({ collection?, maxBytes?, allowedContentTypes?, visibility?, … })`
  (+ `forRootAsync`): an `AGENT_ATTACHMENT_STAGING` backed by `@dudousxd/nestjs-media` (each attachment
  a media record owned by the actor; resolve → presigned/public/inline url; list; owner-or-own-thread
  authorization; `remove` for sweeps; opt-in `indexForRag`), plus resumable upload routes that open an
  owned tus session on nestjs-media's own tus endpoint (`POST/DELETE <path>/attachments/uploads`,
  `POST …/:mediaId/complete`). `@dudousxd/nestjs-agent-react/media` adds `createMediaUpload` (a
  resumable `upload` for `useAttachments` with progress and abort, on `@dudousxd/nestjs-media-client`),
  `mediaAttachments()` — one line, `useAgentChat({ attachments: mediaAttachments() })` — and
  `withMediaUploads(backend)` for other backends. Root react entry: `AgentClientOptions.attachments` /
  `useAgentChat({ attachments })` take an `AttachmentUploadStrategy`, so any upload (media or your own)
  plugs in once. Server `canAccess` overrides the default owner-or-own-thread rule. Both media packages are optional peers — the root
  entries and bring-your-own-storage path are unchanged.

## 0.19.0

### Minor Changes

- [#219](https://github.com/DavideCarvalho/nestjs-agent/pull/219) [`50f76db`](https://github.com/DavideCarvalho/nestjs-agent/commit/50f76db3a7c283bdd576697578c449a4c5b7fcd2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Generative UI, reworked around the three packages apps already use.

  - **core**: the catalog moves to `@dudousxd/nestjs-agent-core/genui` (+ `/genui/builtins`), an isomorphic entry a browser can import (it bundles nothing server-only). `genuiTools` gains `resolveCatalog` (a per-request catalog consulted on every call and every turn's description) and `showTool` (one generic `ui__show` taking `{ component, props }`, for components no boot-time tool can name). `AiToolCtx.emitUi` is now always present — `createNoopEmitUi()` where there is no conversation — so tools call `ctx.emitUi(…)` without `?.`; genui tools no longer fall back to returning props. New `ToolHandler.describe(scope)` lets a tool vary its model-facing description/schema per turn; `definitionsFor` takes an optional `{ threadId, agentName }` scope and `LlmStepEnvelope` carries `threadId`.
  - **nestjs**: `@dudousxd/nestjs-agent/genui` — `AgentGenuiModule.forRoot({ catalog, mode, terminal, treeToolName, treeInstructions, roles, presentation, showTool, resolver })` / `forRootAsync({ imports, inject, useFactory, resolver })` registers the genui tools as agent tools; `GENUI_CATALOG` + `@InjectGenuiCatalog()`; `GenuiCatalogResolver` for per-tenant, versioned catalogs; `provideAgentTools` registers a factory-produced list of tools.
  - **react**: `<GenuiProvider registry catalog resolveComponent fallback treeRenderer>` at the root; `<GenerativeUI part />` and `useGenerativeUI(part)` read it (own props win), and `MessageItem` draws pushed components with no `renderUi` inside one. json-render is an option — `GenuiProvider` from `/genui/json-render` takes `jsonRender` (a json-render registry, or `true` to derive one) — instead of a `genui:tree` registry entry.
  - **mcp-server**: tools get a no-op `ctx.emitUi`.

  The never-published `@dudousxd/nestjs-agent-genui` package is gone; import from `@dudousxd/nestjs-agent-core/genui`.

### Patch Changes

- Updated dependencies [[`50f76db`](https://github.com/DavideCarvalho/nestjs-agent/commit/50f76db3a7c283bdd576697578c449a4c5b7fcd2)]:
  - @dudousxd/nestjs-agent-core@0.26.0

## 0.18.0

### Minor Changes

- [#216](https://github.com/DavideCarvalho/nestjs-agent/pull/216) [`8b0ee4b`](https://github.com/DavideCarvalho/nestjs-agent/commit/8b0ee4bd642152af702a6a1b28f37f3db8381af7) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Headless attachments.

  - `useAttachments({ upload | backend, accept, maxBytes, maxFiles })`: staged items with `status` (`uploading` / `ready` / `error` / `rejected`), `progress`, `error` and image `previewUrl`; `add` (from an input, a paste or a drop), `remove` (cancels the upload), `retry`, `clear`; `isUploading`; `attachments` / `refs` to send; and markup-free `inputProps`, `dropZoneProps` + `isDragging`, `onPaste`.
  - `AgentClient.uploadAttachment(file, { signal, onProgress })` reports upload progress (XHR when no `fetch` was injected) and can be cancelled.
  - `messageFiles(message)` — the files on a message with `kind` (`image` / `pdf` / `text` / `audio` / `video` / `other`), `extension` and, for replayed ones, the stored `mediaId`. Plus `acceptsFile`, `fileKind`, `filesFromClipboard`, `dragHasFiles`.
  - Replayed attachment file parts carry `providerMetadata.agent.mediaId`.

## 0.17.0

### Minor Changes

- [#215](https://github.com/DavideCarvalho/nestjs-agent/pull/215) [`104c3a6`](https://github.com/DavideCarvalho/nestjs-agent/commit/104c3a6a0cc0cbf2d6b101fb648daa2565e1b856) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Quota v2: budget windows, a pluggable QuotaProvider, and a send gate.

  - core: `QuotaProvider` SPI (`report({ actor, now? }) → { windows: [{ period: 'day' | 'month', usedTokens, limitTokens?, usedUsd, limitUsd?, resetsAt? }], blocked?: { period, reason? } }`), `AGENT_QUOTA_PROVIDER`, `exhaustedWindow`, `quotaPeriodRange`. Optional `AgentStore.usageBetween(actorRef, fromDay, toDay)`.
  - nestjs: `GET quota` answers the report. `LedgerQuotaProvider` (the default) reads the usage ledger — a day window (ceiling from the bound `QuotaStore`), plus a month window when the store has `usageBetween`. `AgentModule.forRoot({ quotaProvider })` binds your own (an AI-gateway budget); `quotaLimits: { day?, month? }` (tokens and/or USD) adds ceilings to the default. Either one turns on the send gate: a `blocked` report refuses `POST chat` with `429 { code: 'quota_exceeded', period, message }` before the turn starts. `GET quota/today` is unchanged.
  - stores / testing: `usageBetween` (and `quotaToday` delegates to it).
  - react: headless `useQuota({ backend, pollMs? })` (windows, `day`, `month`, `blocked`; re-read after every run a chat on the same backend settles); `AgentBackend.getQuota?` / `AgentClient.getQuota()`; `useAgentChat({ blocked })` refuses `sendMessage`/`regenerate` with `QuotaBlockedError` while a window is exhausted.
  - codegen: `GET /agent/quota` as `agent.quota.report`; `GET /agent/quota/today`'s response type now matches what it returns.

### Patch Changes

- Updated dependencies [[`104c3a6`](https://github.com/DavideCarvalho/nestjs-agent/commit/104c3a6a0cc0cbf2d6b101fb648daa2565e1b856)]:
  - @dudousxd/nestjs-agent-core@0.25.0

## 0.16.0

### Minor Changes

- [#213](https://github.com/DavideCarvalho/nestjs-agent/pull/213) [`a4dc582`](https://github.com/DavideCarvalho/nestjs-agent/commit/a4dc5823eea59e971404a53b4d7ce0fc7cda88b6) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Model catalog, per-thread and per-send model selection, model/agent picker hooks.

  - core: `ModelCatalog` SPI (`list({ actor, agent }) → { providers: [{ id, label, models: [{ id, label, description?, badges?, available, unavailableReason?, contextWindow? }] }], default }`), `staticModelCatalog`, `findCatalogModel`, `withSelectedModel`, `AGENT_MODEL_CATALOG`. `ModelTurnArgs.model`, `AgentRunInput.model`, `LlmStepEnvelope.model`, `ThreadSummary.model`, `UpdateThreadInput.model`. A turn with a selected model runs every call (answer, structured output, follow-ups, dispatched steps) on it and labels usage with it when the provider reports no model id.
  - nestjs: `AgentModule.forRoot({ models })`; `GET models?agent=` (`ModelsController`; empty catalog when none is bound); `POST chat { model }`; `PATCH threads/:id { model }` (`null` unpins). A model is refused with 400 unless the catalog lists it as available for the actor and agent — checked when pinned and again on every turn. Thread reads normalize `model` to `null`.
  - ai-sdk: `aiSdkModel(model, { resolveModel })` runs the picked id; without a resolver a gateway string id is swapped for the pick and a provider instance ignores it.
  - store-drizzle / store-mikro-orm / testing: `agent_thread.model` (nullable, added by `ensureAgentSchema`, copied on fork), `modelForThread`.
  - react: `useModels({ backend, agent })` (grouped + flattened options, `find`, `defaultModel`), `useAgents({ backend })`; `AgentBackend.listModels?` / `listAgents?` (and `AgentClient` methods); `useAgentChat({ model })` sends it with every turn; `chat.setThreadModel(id | null)`; `ThreadPatch.model`.
  - codegen: `GET /agent/models` as `agent.models.list`; thread summaries carry `defaultAgent`/`activeRunId`/`model`; the thread PATCH body takes `title?`/`defaultAgent?`/`model?`.

### Patch Changes

- Updated dependencies [[`a4dc582`](https://github.com/DavideCarvalho/nestjs-agent/commit/a4dc5823eea59e971404a53b4d7ce0fc7cda88b6)]:
  - @dudousxd/nestjs-agent-core@0.24.0

## 0.15.0

### Minor Changes

- [#211](https://github.com/DavideCarvalho/nestjs-agent/pull/211) [`75eb415`](https://github.com/DavideCarvalho/nestjs-agent/commit/75eb415c98cde1ba3fdd8d0366774c5d7514bfdf) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Pluggable chat backend, resumable streams, message feedback and a thread-list hook.

  - react: `AgentBackend` — the interface every hook talks to (stream start/resume, cancel, thread CRUD required; fork/promote/truncate, approvals, answers, upload, tools, skills, quota, feedback optional). `AgentClient` implements it (new `openChatStream`, `resumeChatStream`, `setMessageFeedback`); `useAgentChat({ backend })` and `AgentChatTransport({ backend })` accept your own (a generated client, cookie session + CSRF). `useAgentChat` is generic over the backend and returns it as `backend` (and `client`), plus `getThreadId()` and `connection`. A missing optional member throws `AgentBackendUnsupportedError`.
  - react: the transport reconnects a dropped, numbered stream from its last frame (`?after=<seq>`) with exponential backoff (`reconnect: { maxAttempts, baseDelayMs, maxDelayMs } | false`); `status` reads `'reconnecting'` meanwhile (`ChatStatus` gains it; the transcript treats it as streaming). A run that ended while away reloads the thread.
  - react: headless `useThreads({ backend })` (list, optimistic rename/remove, refreshed when a chat on the same backend creates a thread, settles a run or streams a title) and `useMessageFeedback({ backend, threadId })`. Live messages carry `metadata.runId`; replayed ones `metadata.feedback` (`AgentMessageMetadata`). `useToolCatalog`/`createSkillsSource` accept any backend with `listTools`/`listSkills`.
  - nestjs: every event frame carries an SSE `id:` (1-based, stable across attaches); `GET chat/:runId/stream` honours `?after=` and `Last-Event-ID`. New `POST messages/:id/feedback` (`MessagesController`, `AgentService.setMessageFeedback`).
  - core: `StoredMessage.feedback`, `MessageFeedback`; optional `AgentStore.threadOfMessage` / `setMessageFeedback`.
  - store-drizzle / store-mikro-orm: `agent_message.feedback` (json, nullable; added by `ensureAgentSchema`, not copied on fork). testing: `InMemoryAgentStore` implements both.
  - codegen: `POST /agent/messages/:id/feedback` as `agent.messages.feedback`; `feedback` on stored messages.

### Patch Changes

- Updated dependencies [[`75eb415`](https://github.com/DavideCarvalho/nestjs-agent/commit/75eb415c98cde1ba3fdd8d0366774c5d7514bfdf)]:
  - @dudousxd/nestjs-agent-core@0.23.0

## 0.14.0

### Minor Changes

- [#209](https://github.com/DavideCarvalho/nestjs-agent/pull/209) [`6149a46`](https://github.com/DavideCarvalho/nestjs-agent/commit/6149a469c466a50f5fa70da3b8d267c886103061) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `@dudousxd/nestjs-agent-react/genui`: headless rendering of server-pushed components. `<GenerativeUI
part registry catalog? resolveComponent? fallback? loading? onError?>` and `useGenerativeUI(part,
options)` resolve `component` (+ `version`) through the app's registry, then an optional async
  `resolveComponent(name, version)` for tenant components (cached), validate props against a genui
  catalog when given (synchronously when possible), isolate each item in its own error boundary and
  hand unknown components, invalid props and renderer errors to the app's fallback. `genui:tree`
  frames render node by node through the same registry. An optional json-render adapter
  (`/genui/json-render`, optional peer `@json-render/react` >= 0.21) renders trees through json-render.
  No styles.

  genui: `catalog.validateSync(name, props)` and `validatePropsSync` — the verdict without waiting
  when the schema can answer synchronously.

## 0.13.0

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

### Patch Changes

- Updated dependencies [[`13b50e2`](https://github.com/DavideCarvalho/nestjs-agent/commit/13b50e24461194aec197e96b82bbee1afc4570c8)]:
  - @dudousxd/nestjs-agent-core@0.22.0

## 0.12.0

### Minor Changes

- [#203](https://github.com/DavideCarvalho/nestjs-agent/pull/203) [`26254d2`](https://github.com/DavideCarvalho/nestjs-agent/commit/26254d2020408e1712555d074a1814a9ba97b66c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Elicitation typed inputs.

  - core: `ElicitationQuestion` gains `description?` and `input?: { type: 'text' | 'textarea' | 'number' | 'boolean' | 'date' | 'email' | 'url' | 'select'; placeholder?; required?; min?; max?; pattern? }`. `options` is optional when `input` asks for a typed value, and a typed question may omit `defaults`. The `ask` tool accepts and describes them. Answers stay `string[]` in one canonical form per type. `validateElicitationValue` / `validateElicitationAnswer` / `readElicitationQuestions` are shared by the loop (which drops values it cannot settle), the server and the client. New optional store method `toolCallInput`.
  - nestjs: `POST tool-call/answer` checks answers against the parked questions and answers `400 answers["<id>"] <reason>` for a value a question refuses, or for a required question left without an answer or default.
  - stores: implement `toolCallInput`.
  - react: transcript questions carry `description`, `input`, `value`, `setValue(raw)` and `error`, and the block carries `isValid`. Headless `coerceAnswer(question, raw)` and `validateAnswer` are exported.

### Patch Changes

- Updated dependencies [[`26254d2`](https://github.com/DavideCarvalho/nestjs-agent/commit/26254d2020408e1712555d074a1814a9ba97b66c)]:
  - @dudousxd/nestjs-agent-core@0.21.0

## 0.11.0

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

### Patch Changes

- Updated dependencies [[`b410e83`](https://github.com/DavideCarvalho/nestjs-agent/commit/b410e836782605c13103ea3782e4146cb07aeefd)]:
  - @dudousxd/nestjs-agent-core@0.20.0

## 0.10.0

### Minor Changes

- [#199](https://github.com/DavideCarvalho/nestjs-agent/pull/199) [`b6edbab`](https://github.com/DavideCarvalho/nestjs-agent/commit/b6edbab8897179a87dce50e6ac45f90b91f4b91f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Tool presentation declared on the server, and a headless tool-activity model on the client.

  - core: `ToolPresentation` (`label`, `running`/`done` templates over the call's input, `icon`, `detail`, `tone`, `confirm: { title, verb, detail? }`, `result` view over the output), `ToolResultView` (`metrics` / `table` / `log` / `note` / `elsewhere`), `ToolCatalogEntry`; `ToolSpec.presentation` (never shown to the model); `ToolRegistry.visibleSpecs` — whole specs behind the same gates as `definitionsFor`.
  - nestjs: `@AiTool({ presentation })`; `GET /agent/tools?agent=` returns `ToolCatalogEntry[]` for the tools the caller can reach through that agent (default agent when omitted, `404` for an unknown one).
  - react: `AgentClient.listTools`, `useToolCatalog({ client, agent? })` (one shared request per client + agent), `phraseFor` / `fillTemplate` / `readPath` / `toolCatalogFrom`, `resolveResultView` / `inferResultView`, `toolCallState` / `correctedCallIds` / `isActionCall` / `describeToolCall`, and `groupToolActivity` (group by label or any key, counts, worst status, nested-call counts or expansion, corrected-failure hiding). `useChatTranscript({ toolCatalog })` gives every tool call a `description` and every tool block an `activity` grouping.
  - codegen: `GET /agent/tools` in the generated client; `StoredMessage` mirror gains `reasoning`, `reasoningMs`, `ui`.

### Patch Changes

- Updated dependencies [[`b6edbab`](https://github.com/DavideCarvalho/nestjs-agent/commit/b6edbab8897179a87dce50e6ac45f90b91f4b91f)]:
  - @dudousxd/nestjs-agent-core@0.19.0

## 0.9.0

### Minor Changes

- [#197](https://github.com/DavideCarvalho/nestjs-agent/pull/197) [`70a3766`](https://github.com/DavideCarvalho/nestjs-agent/commit/70a3766ffa662392394c28f3336146cc157b7f96) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Reasoning and pushed UI survive a reload.

  - core: `StoredMessage` / `AppendMessageInput` gain `reasoning?`, `reasoningMs?` and `ui?: AgentUiComponent[]`; `ModelTurnResult` gains the same three (optional). New `observeTurnFrames` / `withTurnFrames` derive them from the frames a provider streams (thinking time = sum of each burst of consecutive `reasoning` frames), inside the model checkpoint so replays read the journaled values. The loop persists them on each step's assistant message and adds `reasoningMs` to `step-finish`.
  - nestjs: the dispatched `llm` step derives them the same way, so they ride its journaled result.
  - store-drizzle: `agent_message.reasoning` / `reasoning_ms` / `ui` columns, added to existing databases by `ensureAgentSchema`'s additive pass (ALTERs in the README for drizzle-kit users); copied on fork.
  - store-mikro-orm: the same three entity properties (the safe schema update adds them); copied on fork.
  - testing: `InMemoryAgentStore` persists them; `EVERY_MESSAGE_FIELD` includes them, so adapter round-trip specs must cover them.
  - react: `storedMessageToUiMessage` emits a `reasoning` part before the text and `data-ui` parts for persisted components. The transport stamps `step-finish.reasoningMs` (or the time it watched, as a fallback) on the reasoning part's `providerMetadata.agent.reasoningMs`, and `TranscriptReasoningBlock.durationMs` reads it — the same value live and reloaded. New headless `useElapsed(running)`, `formatElapsed(ms)` and `readReasoningMs(part)`. The registry `ChatReasoning` derives its duration label from them when the host passes none.

### Patch Changes

- Updated dependencies [[`70a3766`](https://github.com/DavideCarvalho/nestjs-agent/commit/70a3766ffa662392394c28f3336146cc157b7f96)]:
  - @dudousxd/nestjs-agent-core@0.18.0

## 0.8.0

### Minor Changes

- [#195](https://github.com/DavideCarvalho/nestjs-agent/pull/195) [`7e06e5a`](https://github.com/DavideCarvalho/nestjs-agent/commit/7e06e5ac9c3ec81732e3ff3b1714b627876097cd) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Stream vocabulary for generative UI, titles, approval metadata and nested tool calls — usable by runners that are not this library's loop (contract: `docs/stream-protocol.md`).

  - core: `AgentStreamEvent` gains `ui` (`{ id, component, props, version? }` — a server-pushed component addressed by registry key, not by tool name), `title` (`{ title }`), `approval-requested` (`{ id, approver, expiresAt?, reason? }` — who has to settle a parked action call, and until when) and an optional `parentId` on `tool-input-start`/`tool-input-available` for nested calls. New payload types `AgentUiComponent` and `AgentApprovalRequest`. Readers must tolerate unknown kinds.
  - react: `AgentChatTransport` maps `ui` → `data-ui` part (keyed by component id, updated in place; closes the open prose so later text renders after it), `approval-requested` → `data-approval-requested` part plus the AI SDK's native `tool-approval-request` (the tool part moves to `state: 'approval-requested'`; only for calls the stream announced), `title`/`cancelled` → transient `data-title`/`data-cancelled`, and forwards any unknown kind as `data-<kind>` instead of dropping it. `parentId` rides `toolMetadata` and survives the later input frame.
  - react: `useAgentChat` gains `onData` and `onTitle`.
  - react: the transcript model adds a `ui` block, and every `TranscriptToolCall` now carries `toolKind`, `parentId`, `children` and `approval` (`{ approver, expiresAt, reason }` or `null`); `TranscriptToolBlock.roots` is the calls as a tree. `MessageItem`/`MessageList` take a `renderUi` slot (unstyled, `data-slot="ui"`); pushed components are not drawn without one.

### Patch Changes

- Updated dependencies [[`7e06e5a`](https://github.com/DavideCarvalho/nestjs-agent/commit/7e06e5ac9c3ec81732e3ff3b1714b627876097cd)]:
  - @dudousxd/nestjs-agent-core@0.17.0

## 0.7.5

### Patch Changes

- Updated dependencies [[`8a4ec35`](https://github.com/DavideCarvalho/nestjs-agent/commit/8a4ec35a9da5b697d71955a0a8437c810221e208)]:
  - @dudousxd/nestjs-agent-core@0.16.0

## 0.7.4

### Patch Changes

- Updated dependencies []:
  - @dudousxd/nestjs-agent-core@0.15.5

## 0.7.3

### Patch Changes

- Updated dependencies [[`3a3e75f`](https://github.com/DavideCarvalho/nestjs-agent/commit/3a3e75f6aa3b3efaaeb6235a0d4bb4048357458b)]:
  - @dudousxd/nestjs-agent-core@0.15.4

## 0.7.2

### Patch Changes

- [#131](https://github.com/DavideCarvalho/nestjs-agent/pull/131) [`df889d9`](https://github.com/DavideCarvalho/nestjs-agent/commit/df889d953f7d92ace46d22b1d33db2cdab88f7c2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A declined action reads as a decision, not as a malfunction

  When a person pressed "Not now" on an action tool, the loop handed the model a tool result whose error text was the single word `rejected`. That names no actor and is indistinguishable from a tool that threw, so the answer that followed diagnosed the refusal — "the key may not exist", "there may be permission restrictions", "the cache system may have rejected it for another reason" — and offered to retry the same action, asking the person to say no twice.

  The same word went out on the `tool-output-error` frame, so a client drew the refusal with the treatment a crash gets. And a reloaded thread was worse: the stored result mapped to `output-available`, which reads as a completed call, so after a refresh the action a person had refused was shown as one that had been carried out.

  - `ToolResult` gains `denied?: true`. It is set instead of a failure and read by everything that has to tell the two apart; `error` still carries what the model is told, because that is the channel a model reads an outcome on.
  - The model-facing text now says who decided, that nothing ran, and what not to do next — do not explain it as an error, do not guess at causes, do not retry or reach for another way to do the same thing. A reason given when declining is included.
  - New `tool-output-denied` stream frame, mapped by the React transport onto the SDK's `output-denied` tool part state.
  - `storedMessageToUiMessage` reloads a declined call as `output-denied`, including for threads written before the `denied` flag existed.

- Updated dependencies [[`df889d9`](https://github.com/DavideCarvalho/nestjs-agent/commit/df889d953f7d92ace46d22b1d33db2cdab88f7c2)]:
  - @dudousxd/nestjs-agent-core@0.15.3

## 0.7.1

### Patch Changes

- Updated dependencies [[`648fef6`](https://github.com/DavideCarvalho/nestjs-agent/commit/648fef61c336022ffb126ac15ab325387c05c49a)]:
  - @dudousxd/nestjs-agent-core@0.15.2

## 0.7.0

### Minor Changes

- [#126](https://github.com/DavideCarvalho/nestjs-agent/pull/126) [`d4fcbd0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d4fcbd05cdecae7815c02a00c89463c69dd4b26f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **A parked call now reports WHICH decision is in flight, not merely that one is.**

  `TranscriptSettleState` is per action — `approve` and `reject` each carry their own
  `isSubmitting`, as do `answer` and `skip` — so a consumer reasonably reads one as "this decision is
  being sent". They were always equal: `useChatTranscript` tracked settling in a `Set` of
  `toolCallId`, which knows that _a_ decision is on its way and discards which, and `buildToolCall`
  copied that one boolean into both. A surface reading `approve.isSubmitting` therefore said
  "Working…" on Allow while the run was carrying out a refusal.

  The set is now a `Map<toolCallId, SettleAction>`, and each `isSubmitting` is derived from it. The
  information was always there — `approve` calls `settle(id, () => onApprove(id))` — it was just not
  kept.

  **Breaking for anyone calling `buildTranscriptBlocks` directly.** `ElicitationBlockOptions` and
  `ApprovalBlockOptions` replace `isSubmitting: (toolCallId) => boolean` with
  `submitting: (toolCallId) => SettleAction | null`. `useChatTranscript` supplies it; hosts that pass
  their own options need the one-line change. The new `SettleAction` type is exported.

  `available` is untouched and still means "this decision can be made at all", not "nothing is in
  flight". Holding both affordances while one is going is the renderer's call, and the two
  `isSubmitting` flags are what let it do that while reporting progress on only the pressed one.
  Both `registry` renderers now do it — `ChatToolGroup` and `ChatElicitation` — the second because a
  second `settle` for one call overwrites the first, so both sends would be in flight while only the
  later one reported progress.

## 0.6.4

### Patch Changes

- Updated dependencies []:
  - @dudousxd/nestjs-agent-core@0.15.1

## 0.6.3

### Patch Changes

- [`6b12f22`](https://github.com/DavideCarvalho/nestjs-agent/commit/6b12f227f1d767aa579df91e2c2c473c0a46b0b2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix a stale symbol reference in the `storedThreadToUiMessages` docblock

  The note explaining why `{type: 'step-start'}` parts are not reproduced pointed at
  `MessageItem`'s `renderParts`, which exists nowhere in the repo — the function is
  `renderBlocks` in `components/message-item.tsx`. The same sentence also claimed it
  "only special-cases text and tool parts", while `renderBlocks` branches on four block
  kinds: text, reasoning, files and tools.

  Comment-only; no runtime change.

## 0.6.2

### Patch Changes

- Updated dependencies [[`3061f77`](https://github.com/DavideCarvalho/nestjs-agent/commit/3061f77548d48a8aa88b02eca46b04d24848646a)]:
  - @dudousxd/nestjs-agent-core@0.15.0

## 0.6.1

### Patch Changes

- Updated dependencies [[`d7f2cf2`](https://github.com/DavideCarvalho/nestjs-agent/commit/d7f2cf260ab0e87a012b21d681f805eb6758129a), [`31caa9e`](https://github.com/DavideCarvalho/nestjs-agent/commit/31caa9e48e9b8be948b54dd252057a01355f4924)]:
  - @dudousxd/nestjs-agent-core@0.14.0

## 0.6.0

### Minor Changes

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Start a sub-agent and keep talking.

  A delegation was synchronous: an `agent`-kind tool mapped to a child run the parent **awaited**, so
  the conversation was held open for as long as the specialist took. For a specialist that takes
  minutes, that is the wrong shape — the user sits watching a spinner for work they never needed to
  watch.

  An edge can now be declared detached, and then it isn't:

  ```ts
  @Agent({
    name: 'ops-orchestrator',
    handoff: [
      WeatherAnalystAgent,                           // awaited  -> ask_weather_analyst
      { agent: DeepResearchAgent, detached: true },  // detached -> start_deep_research
    ],
  })
  ```

  The turn ends with a **receipt** (`{ detached: true, status: 'started', agent, runId, note }`) as the
  call's result instead of an answer, and the started run posts its answer into the same thread later,
  as its own message stamped with its own `runId` and `agentName` — so a client renders "the research
  agent finished" rather than the assistant's next reply. The `note` says the same thing in prose,
  because a tool result is the only vocabulary a model reliably acts on, and a model handed something
  shaped like a result will report one.

  **The author declares it, per edge — the model does not.** A model that can decide to detach can
  decide to detach the one thing the user is sitting there waiting for, and it has no way to know which
  that is. The same specialist can be both: `ask_<name>` and `start_<name>` are separate tools.

  **Determinism.** Whether a call detaches is settled inside its `persist:toolcall` checkpoint, beside
  the kind and target that already live there, and read back from the journal on every replay — never
  from a registry lookup in whichever process happens to be replaying. Flipping an edge therefore
  changes what new runs do and nothing about a run already in flight. The loop writes the SAME
  checkpoint names for both branches; only the runner's own positions differ (`ctx.startChild`'s
  `spawn:<id>` instead of the awaited child's suspend-and-join). A deployment that declares no detached
  edge writes byte-identical checkpoints, payloads included, and needs no patch marker.

  **Streaming and approvals.** A detached run owns its own sink and its `action` tools park on its own
  run, so its tokens and its approval card never land in a stream whose reader has already seen `done`,
  nor in whatever unrelated turn happens to be open next. Its approval goes to the pending-approvals
  inbox, which it reaches for free — the call is persisted `pending_approval` against the child's own
  `runId`, and that is what `runForToolCall` answers with. The run is subscribable on its own id.

  **Lifecycle.** It parks on an approval nobody gives, with no library-owned timeout — a deadline on a
  human decision is the host's policy — and stays visible and cancellable meanwhile. Cancelling the
  turn that started it takes it with it (the durable runtime cascades to children). Delivery is skipped
  when the thread was deleted. A run that dies or is stopped posts a message saying so and settles its
  delegation's row, because `started` is the one state a reader can neither wait on nor act on.

  **Observability.** Both the awaited and the detached child now record `parentRunId` on
  `AgentStore.recordRunStart` (optional on the SPI; a store that persists nothing for it loses the
  tree, not the run), so a delegation's cost can be rolled up to the turn that asked for it. The
  `aviary:agent:delegated` event carries `detached`.

  **The client.** `useAgentChat({ background: true })` exposes `background.runs` / `background.isWorking`
  / `background.refresh()`, and appends a delegate's answer to `messages` when it lands — no reload.
  Both halves come from one thread read, so a reload or a second tab sees what the tab that started it
  sees; the interval (`backgroundPollMs`, default 5000) exists only while something is outstanding.
  `storedThreadToUiMessages` also stops merging consecutive assistant rows from **different runs**,
  which it had to: a detached answer merged into the previous turn reads as the assistant having said
  both.

  **Breaking.** `delegateToolName(target)` now takes `delegateToolName({ target, detached })` — a
  detached edge needs its own name, since one agent can be both awaited and backgrounded by the same
  orchestrator and one tool name cannot carry both. `AgentDefinition.delegatesTo` is now
  `AgentDelegation[]` (`string | { agent, detached? }`); a bare name still means exactly what it did.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A file on a message is content, an unpriced turn is not a free one, and a message can carry a badge.

  Three things a host had to reimplement the whole message item to get.

  **Files were dropped on the floor.** `buildTranscriptBlocks` modelled text, reasoning and tool runs
  and skipped everything else, so an attachment a user uploaded — which `POST /agent/attachments`
  stages, the transport carries, and the model reads — rendered as nothing at all. The turn read as if
  only the prose had been sent. Consecutive file parts now fold into a `files` block whose entries
  carry `url`, `mediaType`, `filename` and `isImage`; `MessageItemView` shows images inline and links
  anything else, and `renderFiles` takes the whole run for a host that wants a gallery or a viewer.
  Files terminate a tool run and vice versa, because where a file sits in a turn is meaning: one
  attached before the question reads differently from one the run produced after searching.

  **`MessageUsageInfo.costUsd` is `number | null`.** A turn whose model has no row in the pricing
  store has no cost, which is not the same fact as a turn that cost nothing — and `describeUsage`
  was printing `$0` for both. `null` now renders as `—`. This widens the type, so a host already
  supplying a number is unaffected; a host reading `costUsd` off the summary gets a null to handle,
  which is the point.

  **`meta` on the action row.** The row had a fixed set of affordances and no room for the one thing
  that varies per message — which agent answered, what state it is in. `MessageItem` takes a `meta`
  node, `MessageList` takes `getMeta(message)`, and both render it between the buttons and the usage
  line. Without it, a multi-agent host had to fork the component to add a badge.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Give the composer a completion menu, and give it no opinion about what it completes.

  Typing `/` now opens a filtered, keyboard-driven list that inserts what you pick.
  `useComposerAutocomplete` is that as a model: which trigger the caret is inside, the query, the
  items, the highlight, whether a source is still answering, and what accepting one does to the text
  and the caret. It renders nothing.

  It is source-agnostic on purpose. A host supplies sources, each with a trigger character and a
  `getItems`, so `@` to mention an agent or a thread is another entry in the array rather than a
  second component. Skills — the immediate use — are one source like any other; nothing in the
  composer knows what a skill is.

  **The trigger rule is per source and has no default.** `position: 'start'` fires only as the first
  character of the input, which is what a slash command wants: `/deploy` is a command, `src/foo` and
  `and/or` are not. `position: 'word'` fires at the start of any word, which is what a mention wants:
  `@ada` mid-sentence is a mention, `ada@example` is an address. Getting this wrong breaks the case
  people type most, so the source states it rather than inheriting a guess.

  Accepting replaces the token, keeps the trigger and appends a space — `/roll` + _rollback_ →
  `/rollback ` with the caret after it — and leaves anything to the right of the caret where it was.
  The space closes the menu, so typing on is free text; `insertSuffix: ''` opts out. ↑/↓ move and
  wrap, Enter and Tab accept, Escape closes for that token, Shift+Tab still moves focus. Every key the
  menu takes is `preventDefault`ed, which is how a composer that sends on Enter knows to stand down.

  An async source is asked per query with an `AbortSignal`. An answer to a query the user has already
  typed past is discarded instead of overwriting a newer list, and the request behind it is aborted; a
  source that throws reports itself in the menu and leaves typing and sending alone.

  Skills are the first source, and nothing about them is special-cased. `createSkillsSource` reads
  `GET /agent/skills` — the scope-resolved list of what this actor can invoke, built by the same call
  that offers the catalog to the model, so what a user can type after a `/` and what the agent can
  reach cannot drift apart — once per thread rather than once per keystroke, since the endpoint
  answers with the whole list and the narrowing is local. Every row shows where its skill came from,
  and says `overrides` when one shadows another — `shadows` is set only on a clash, so "there is no org
  default" and "there is one and yours wins" do not read the same. The received order is the
  precedence and is left alone. `AgentClient` gains the matching `listSkills`.

  An empty menu says which kind of empty it is: "Nothing to complete" when a source offered nothing at
  all, "No matches" when a query matched none of what it offered.

  It is a combobox, wired as one: `getInputProps` puts `role`, `aria-expanded`, `aria-controls` and
  `aria-activedescendant` on the textarea, and `getListboxProps`/`getOptionProps` put `listbox`/
  `option` and the ids they point at on the list.

  In the shadcn registry, `ChatComposer` gains `autocompleteSources` and wires all of it, and
  `ChatCommandPalette` grows into the popup half rather than a second palette appearing beside it —
  handed the prop-getters its rows become `option`s and stop being focus stops, so focus never leaves
  the composer mid-query, and its `↑↓ navigate · Enter select · Esc` hint row finally describes keys
  that work. Handed `suggestions` as before, it behaves exactly as before.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Give the chat components a model to render.

  `MessageItem` and `MessageList` were style-agnostic, not headless: a `classNames` slot map and three
  render props let you restyle the markup this package chose, but the markup was still this package's.
  An app that wanted a different layout had to reimplement the logic those components hold — grouping
  runs of consecutive tool parts, the edit-and-resubmit state machine, the copy-then-reset flash, the
  windowed mount, the relative-time and cost/token derivations. The main consumer did exactly that,
  and its 615-line message item lost `copy` and `fork` on the way, both of which shipped here already.

  `useChatTranscript` is that logic with nothing drawn. It returns items whose parts are already
  grouped into text / reasoning / tool **blocks**, each carrying its derived values (the copyable
  prose, a usage summary with its labels, a described timestamp) and each action as a state machine
  rather than a button: `item.copy.copied`, `item.edit.isEditing`/`draft`/`canSave`/`save()`,
  `item.fork.run()`, `item.regenerate.available`. List-level state — the mounted window and its
  `loadEarlier`, whether an empty state / typing indicator / follow-ups belong on screen, the stop
  machine — sits on the instance. `useTranscriptItem` is the single-message half, for a host that
  lays out the list itself. The model names no class and returns no node; where a value existed only
  to feed a specific DOM shape, it stayed in the renderer.

  This is additive. `MessageItem`, `MessageList` and `ChatInput` keep their props and their behaviour
  exactly, and are now one rendering of the model — `MessageItemView` is that renderer, exported so a
  host can drive the model itself and still get the default markup for a message. Every existing
  component spec passes unchanged.

  **Two capabilities the backend already paid for now reach the screen.** Reasoning frames have been
  mapped to `reasoning-start`/`reasoning-end` chunks by `AgentChatTransport` since v7 support landed,
  so reasoning parts were arriving on every `UIMessage` and no component looked at them; a reasoning
  run is now a block of its own, open while it streams and folded once the answer lands, with
  `renderReasoning`/`reasoningLabel` slots. And `POST /agent/chat/:runId/cancel` had no affordance
  anywhere — `ChatInput` gains `onStop`/`isStreaming`, and the model exposes `stop.available` /
  `stop.isStopping` so a host can render "Stopping…" for the gap between the click and the run
  actually settling.

  **Stick-to-bottom is model state, not a component behaviour.** `useStickToBottom` (also reachable as
  `transcript.scroll`) follows the stream only while the reader is at the bottom, stops the moment they
  scroll up, and says whether a "jump to latest" affordance is warranted — the bug where reading back
  through a thread yanks the viewport away on every token, fixed once, for every renderer.

  The package entry also drops its `export *` over the component barrel in favour of named re-exports.
  A wildcard hides from a bundler which names a consumer actually uses, and has broken a downstream
  build in this ecosystem before.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Render the question the agent asked — and settle it — from the client.

  Elicitation shipped complete on the server and completely absent from the client. The transport's
  event switch had no `elicitation` case, so the frame fell through `default: break` and the question
  set was dropped in silence; `AgentClient` had no `answer`/`skip`, so every consumer hand-rolled the
  fetch; and there was no inline surface, so the only place a form could go was a side panel beside
  whatever conversation happened to be on screen.

  **The orphan settlement.** Worse than a missing form: an authored intake asks BEFORE the turn's first
  model call, so its later `tool-output` was the first the client ever heard of that tool call. The AI
  SDK settles a tool part by looking it up by call id and throws `UIMessageStreamError` when there is
  none — which drops the whole streamed message, with no console error. The answer was in the store and
  nothing rendered. The transport now opens the part when the `elicitation` frame arrives, carrying the
  request as the call's `input` under the name the row is persisted with (`ask`), so a live turn and a
  reloaded thread produce the identical part. A call the stream already announced — the model's own
  `ask` — is left exactly as it was, so a consumer's `onToolCall` never fires twice for one call.

  **`AgentClient.answerToolCall({ toolCallId, answers? })` and `skipToolCall({ toolCallId })**, matching
  `approveToolCall`/`rejectToolCall` in shape and in raising `AgentHttpError` for the status. Omitting
  `answers` submits nothing and lets every question take the default it was shown with. `useAgentChat`
  exposes them as `answer`/`skip` beside `approve`/`reject`.

  **The transcript model** gains an `elicitation` block: the preamble, the questions numbered against
  `questionCount`, each option with its `hotkey`, `isDefault` and `isSelected`, a `selected` list, an
  `isPristine` flag, and `answer`/`skip` as state machines with `available`, `isSubmitting` and a
  surfaced `error`. Only the questions the user actually TOUCHED are submitted, so the questions they
  left alone still persist as `defaulted` rather than as choices they made. A settled set keeps
  rendering — read-only, showing what was chosen — through the same markup. Lifting is opt-in on
  `onAnswer`, exactly as `sources: true` is: without somewhere to send an answer, a question set is
  still a tool card. Detection is structural, never by tool name, because an intake and an `ask` are
  persisted under whatever name their row holds.

  **A tools block now also carries `calls`** — the same parts, each with `isAwaitingApproval` and its
  own `approve`/`reject` machines, wired through `onApprove`/`onReject`. An `action` tool's input lands
  and its output never follows on its own, so a parked-looking card IS the pending approval; a question
  set parks the same way and is excluded, because approving one settles nothing.

  **Registry:** a new `ChatElicitation` renders the form INLINE in the turn that asked it — letter
  hotkeys per option, pre-checked defaults, "Question N of M", Confirm on submit and Skip, light and
  dark, keyboard operable. `ChatToolCard` grew an approve/reject row and reports "Needs approval"
  instead of "Running", and `ChatToolGroup`/`ChatMessage`/`ChatTranscriptView`/`AgentChat` gained a
  `renderToolPart` escape hatch that hands the host the whole call, decision state and all — so HITL is
  finally renderable through `AgentChat` as shipped. `ChatToolGroup` now takes the `tools` block itself
  rather than its `parts`, matching every other component in the block.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Model the provenance behind an answer.

  RAG has been persisting its retrieval since inject mode landed: the passages ride the assistant
  message as an auto-executed tool call whose output is `{ passages }`, and `createRetrievalTool` does
  the same for agentic search. Nothing in this package looked at it. A frontend saw an anonymous tool
  part with a blob of text in it, so the one thing that makes a retrieved answer trustworthy — what it
  was built from — reached the screen as a JSON dump or not at all.

  `useChatTranscript({ sources: true })` lifts those parts into a `sources` block: origins aggregated
  across the passages that share them, each with its passage count and best score, plus the query that
  was searched. Detection is **structural** — a tool output shaped `{ passages: [{ id, text }] }` —
  because the tool's name is not fixed: inject mode records `retrieve`, and `createRetrievalTool` lets
  a host rename `search_knowledge` to anything. A view that matched on tool names would be wrong for
  half the installations, and tool-name matching in a view is exactly the coupling the model exists to
  absorb.

  The option defaults to `false`, so a renderer already drawing tool cards keeps receiving retrieval as
  the tool call it is. `MessageItem`, `MessageList` and `ChatInput` do not opt in, and their behaviour,
  props and specs are unchanged.

  Exported alongside it: `TranscriptSourcesBlock`, `TranscriptSource` and `RetrievedPassage`.

### Patch Changes

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Stop a second turn from duplicating the first in the message list.

  A running chat would fill its console with React's `Encountered two children with the same key`, and
  the transcript would grow copies of the same two messages. The ids were the AI SDK's own, not the
  store's, so nothing persisted was wrong — the live list was.

  The mechanism is the SDK's push-or-replace test. It keeps one in-flight response per chat and, on
  every write, decides whether that response's message replaces the list's last entry or is appended
  by comparing the two ids — **only** against the last entry. One attempt at a time, that is exactly
  right. Two attempts writing into the same chat alternate: A writes and is appended, B writes and is
  appended, A writes again, finds B's message at the end, and is appended a second time. Four writes
  in, the list holds two ids twice each, which is what the console was reporting.

  Two things started a second attempt. React StrictMode runs the SDK's resume effect twice on mount,
  so a chat with `resume`/`resumeRunId` opened two reconnects to the same buffered run and replayed
  the same frames into the same list. And a composer that does not disable itself while busy could
  send twice; the SDK does not survive that either, throwing `Cannot read properties of undefined`
  from its own `finally` once the first attempt cleared the response the second was still using.

  `AgentChatTransport` now admits one attempt at a time. A reconnect that arrives while one is live
  resolves `null` — the SDK's own "nothing to resume", which costs it no state — and the latch is
  released on every terminal path of the chunk stream. `useAgentChat`'s `sendMessage` and `regenerate`
  refuse while a turn is in flight, because the SDK commits its response before a transport can see
  the request, so that call has to be refused earlier than the transport can reach.

  A model-level test now pins the invariant nothing asserted: a transcript's item ids are unique
  across a stream that starts, settles, and is then resumed or raced.

- Updated dependencies [[`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4)]:
  - @dudousxd/nestjs-agent-core@0.13.0

## 0.5.5

### Patch Changes

- Updated dependencies [[`70f3d57`](https://github.com/DavideCarvalho/nestjs-agent/commit/70f3d57dcebd9aec631adc66c40d0715472115d9)]:
  - @dudousxd/nestjs-agent-core@0.12.0

## 0.5.4

### Patch Changes

- Updated dependencies [[`7c27376`](https://github.com/DavideCarvalho/nestjs-agent/commit/7c273763eeb6d5841028612d81acc63b2a8dd4eb)]:
  - @dudousxd/nestjs-agent-core@0.11.0

## 0.5.3

### Patch Changes

- Updated dependencies [[`70114eb`](https://github.com/DavideCarvalho/nestjs-agent/commit/70114ebb9a7a3702d2efdb11e0dea6956a7ba8db)]:
  - @dudousxd/nestjs-agent-core@0.10.0

## 0.5.2

### Patch Changes

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

- Updated dependencies [[`107fcc2`](https://github.com/DavideCarvalho/nestjs-agent/commit/107fcc2c0079f97c3cc9ff8c83f2dc41070244d5)]:
  - @dudousxd/nestjs-agent-core@0.9.0

## 0.5.1

### Patch Changes

- Updated dependencies [[`3d256d4`](https://github.com/DavideCarvalho/nestjs-agent/commit/3d256d4027c7ad819f8ec908425d52887e67da3f)]:
  - @dudousxd/nestjs-agent-core@0.8.0

## 0.5.0

### Minor Changes

- [`6263338`](https://github.com/DavideCarvalho/nestjs-agent/commit/6263338cf86df7b51cb082d5d2d575987cd13383) - Stored-history UX parity with the live stream:

  - `storedThreadToUiMessages(messages)` merges consecutive assistant rows (one model TURN persists
    one row per iteration) into a single `UIMessage` with parts concatenated in step order — a
    reloaded thread renders one response bubble per turn, matching the live stream, instead of 2-3
    fragments each with its own footer. Merged turns carry `metadata.usage` with summed tokens and
    cost (`costUsd` stays `null` only when every merged row's cost is unknown — unknown ≠ $0).
    `storedMessageToUiMessage` (1:1) is unchanged.
  - `useAgentChat({ onRunSettled })` — fires exactly once per run with
    `{ runId, status: 'completed' | 'failed' }` when the stream settles (send and resume paths). The
    server has persisted the thread title and run outcome by then — refetch thread/list queries here
    (fixes "Untitled" never updating in headers/sidebars).

### Patch Changes

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

### Minor Changes

- [#3](https://github.com/DavideCarvalho/nestjs-agent/pull/3) [`abb32bc`](https://github.com/DavideCarvalho/nestjs-agent/commit/abb32bc0396c65a59ee2b92a1a8b07d772215e31) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Ports the `StoredMessage → UIMessage` adapter consumers were hand-writing into the package as
  `storedMessageToUiMessage()`: text/attachment/tool parts, pairing a tool call with its result by id
  (falling back to `input-available` when a call never finished), and carrying the store's `toolKind`
  through as `toolMetadata` so a UI can gate approval affordances on `kind === 'action'` without
  hardcoding tool names.

  `AgentChatTransport` now forwards `toolKind` from `tool-input-start`/`tool-input-available` stream
  frames onto the emitted chunks' `toolMetadata`, and surfaces a step's `costUsd` (from `step-finish`)
  as a `message-metadata` chunk merged onto `message.metadata`. Both are additive and backend-version
  tolerant — an older backend that omits the fields never crashes the client.

  `useAgentChat` gains a `resume` option: when `true`, the hook fetches the thread on (re)mount and,
  if it carries a live `activeRunId`, automatically attaches to that run's stream — no more manually
  plumbing `resumeRunId` from a separate thread fetch. The resolved `activeRunId` is exposed on the
  hook's return value. `AgentClient` gains `updateThread(id, { title?, defaultAgent? })` (general
  `PATCH /agent/threads/:id`, which `renameThread` now delegates to) and `uploadAttachment(file)`
  (multipart `POST /agent/attachments`, returning a `MessageAttachment` ready to ride a send's
  `attachments`).

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

- [`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46) - Fix a threadless chat spawning a new thread on every message. `useAgentChat` captured the
  backend-created thread id from the `meta` frame only into `runId` — so the next send still carried
  no `threadId` and the backend minted another thread. It now remembers the created id and reuses it
  on subsequent sends, and exposes an `onThreadCreated(threadId)` callback so the consumer can sync its
  URL/router to the newly created thread (title, sidebar, and reload then bind to it).
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
