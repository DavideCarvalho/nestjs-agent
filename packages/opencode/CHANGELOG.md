# @dudousxd/nestjs-agent-opencode

## 0.5.0

### Minor Changes

- [#386](https://github.com/DavideCarvalho/nestjs-agent/pull/386) [`70a6f26`](https://github.com/DavideCarvalho/nestjs-agent/commit/70a6f26f5d7eaa7502ef34069f23b1b1fac8b503) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Run metrics: time to first token, cost and model on the run, and settle diagnostics with context.

  - `run.finished` carries `durationMs`, `ttftMs` (turn start to the first non-empty `text` frame), `costUsd` (sum of the model calls with a known cost), `modelId` (the last call's) and the run's context (`actorId`, `agentName`, `tenantRef`, `parentRunId`). The start is the journaled `run:started-at` and the first-text instant is journaled with the checkpoint that wrote it, so a resumed run keeps its figures.
  - `run.failed` gains `threadId`, `durationMs` and `context` (it keeps `message`); the new `run.cancelled` is published instead of it when a run is stopped — by the inline and durable runners and by OpenCode. `runDurationMs(error)` and `agentRunContext(input)` give a runner the same figures.
  - `tool-call` gains `toolCallId` and `replayed: true` (an outcome re-published by a durable replay); its `durationMs` is now measured inside the `tool:<callId>` checkpoint, or on the worker for a dispatched call.
  - `agent_run` gains nullable `ttft_ms`, `cost_usd` and `model_id` (in-memory, Drizzle — added by `ensureAgentSchema` — and MikroORM, schema revision 4); `RecordRunEndInput` and `RecentRunRow` carry them, and `RunMetrics` gains `ttftP50Ms`/`ttftP95Ms` over completed top-level runs.
  - Dashboard: a TTFT stat in Reliability, TTFT/cost/model in the run detail, and `run.failed`/`run.cancelled` in the live feed. Telescope: a TTFT distribution and TTFT p50/p95 stats, failures by code and a cancelled count.

## 0.4.1

### Patch Changes

- [#382](https://github.com/DavideCarvalho/nestjs-agent/pull/382) [`7a1b3bf`](https://github.com/DavideCarvalho/nestjs-agent/commit/7a1b3bf01632f6d0eaf98e20a62b39cd81b324e3) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A durable turn whose API restarted while OpenCode worked no longer settles as an empty success. The re-run `observe` step re-attached and caught up on open permissions and forms only, so the text, tool calls and usage OpenCode streamed meanwhile were lost and the turn ended `succeeded` with no text and zero usage. Now the rebuilt turn, when the execution ends, reads back the session's messages after the turn's prompt (the prompt carries the run id in its `metadata`) and takes what it missed as the events would have — less what was taken before the restart, journaled with each `ask` milestone (`TurnProgress`), so nothing is persisted or counted twice. A session that left no answer for the turn fails it with `LOST_ANSWER_ERROR` instead. `OpenCodeClient.message.list` now types the messages (`OpenCodeMessage`) and takes a `cursor`; `session.prompt` takes `metadata`.

## 0.4.0

### Minor Changes

- [#375](https://github.com/DavideCarvalho/nestjs-agent/pull/375) [`94d74ba`](https://github.com/DavideCarvalho/nestjs-agent/commit/94d74ba70bf5ed7250ee30a2ce1820b01fbb3284) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Generative UI: the sandbox's code is checked before a call is accepted, and every UI call is recorded as telemetry for a new dashboard page.

  - **Validated before accepted.** `ui__sandbox` (and a `Sandbox` inside a `ui__render` tree) parses its JSX with the frame's own transpiler plus acorn/acorn-jsx, and its HTML scripts, `on*=` handlers, `jsFunctions` and `jsExpressions` with acorn. It checks that `App` exists, refuses any bridge other than `agent.send` (`flippy.send(…)`, `window.x.send`, `agent.post`) and any `<Component>` the kit's docs do not have, and warns about undeclared props. The model gets a short error with line, column and a one-line fix: `` invalid Sandbox code: jsx line 12:5: `flippy.send` — the bridge is `agent.send(payload)`  ``. A component of your own can do the same with `defineComponent({ check })`. The parsers load on first use, server side only. `validateSandboxCode` is exported.
  - **An example per mode.** `ui__sandbox`'s description ends with one minimal valid call: JSX with the kit, or HTML. The JSX is a quoted JSON string. It adds about 70–77 prompt tokens (o200k), only on turns that offer `ui__sandbox`.
  - **Telemetry.** Genui tools are marked `ToolSpec.genui` (`{ mode, telemetry? }`). For each UI call the loop records tool, channel, mode, model, attempt, validity (`first_try` / `retried` / `failed`), error category, the call's share of its step's tokens and cost, and the time from turn start to its first and complete frame. It goes through the new optional `AgentStore.recordGenuiCalls`, into the in-memory store, or into the library-owned table `agent_genui_call`, which the Drizzle (`ensureAgentSchema`) and MikroORM (boot heal) stores create themselves.
  - **OpenCode.** The UI calls OpenCode's code mode makes through the MCP endpoint are recorded too, with attempts counted per run (`GenuiRunRecorder`). There the tokens are not split per call and the frames are not timed.
  - **Privacy.** A row is metadata only, with quoted values scrubbed from error messages. Nothing app-side needs migrating. `telemetry: { samplePayloads: true }` also stores the call's input, for debugging only. `telemetry: false` records nothing.
  - **Dashboard.** A new "Generative UI" page, backed by `GET <api>/genui` and the optional `AgentGovernanceQueries.genuiStats`, shows first-try success per tool and model, common errors, UI cost per turn and per day, and p50/p95 time to first and complete frame.

## 0.3.0

### Minor Changes

- [#370](https://github.com/DavideCarvalho/nestjs-agent/pull/370) [`4d99636`](https://github.com/DavideCarvalho/nestjs-agent/commit/4d9963656f51da4a0f709f996d0346da66c4fc4a) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Approval prompts read as the tool's own words on every adapter. A new shared helper in core, `resolveToolConfirmation(toolName, input, presentation?)` (with `humanizeToolName` and `DEFAULT_CONFIRM_VERB`), words a prompt: the tool's `presentation.confirm` filled from the call input, else `"<presentation.label>?"`, else the humanized name (`refund_order` → "Refund order?") — never the raw identifier.

  - AG-UI: an interrupt's `message` is the confirmation title (it now outranks a free-form `reason`); without one it is the humanized name instead of `Approve <tool>?`.
  - A2UI: the approve button is labelled with the confirmation's `verb` ("Refund"), and an approval without a confirmation reads as the tool's name in words instead of `Approve?`.
  - Independent proposals: the stored confirmation is filled by the shared filler (placeholders collapse like everywhere else) and falls back to the label / humanized name instead of `Allow <tool>?`.
  - Channels: the approve button uses the tool's `confirm.verb` (the localized `texts.approve` when none was declared), a label-only press of that verb still decides the card, and the no-confirmation fallback no longer prints the identifier. Requires core >= 0.55.0.
  - OpenCode: a module tool's approval carries its filled `confirmation` (stream event and persisted row), resolved from the tool's presentation behind OpenCode's prefixed name. Requires core >= 0.55.0.

## 0.2.1

### Patch Changes

- [#348](https://github.com/DavideCarvalho/nestjs-agent/pull/348) [`545e500`](https://github.com/DavideCarvalho/nestjs-agent/commit/545e5006c95408f601cf8879ae6969ef5d506826) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Record the title OpenCode generates (and a compaction) even though OpenCode 2.0 does not stream those calls: a turn reads the session's spend (`session.get`) before it prompts and, when the execution ends, records what the session spent that its steps did not report as a `title` (or `history_summary`) usage row, counted in the run's usage. `OpenCodeClient.session.get` may return the session's `cost` and `tokens`.

## 0.2.0

### Minor Changes

- [#346](https://github.com/DavideCarvalho/nestjs-agent/pull/346) [`52f914f`](https://github.com/DavideCarvalho/nestjs-agent/commit/52f914f2e8ed5e23429e9194f73c874533437d67) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - OpenCode turns are priced and recorded like the loop's own: every model call OpenCode makes (each step, the session title, a compaction) goes to the token-usage ledger with `cost_usd` and `cost_source`. OpenCode's own figure wins when it priced the call; a call it priced at 0 is estimated from the library's price (the pricing store, `priceCatalog.prices`, the built-in GovCloud Bedrock table, models.dev), so `priceCatalog` now applies to OpenCode too. `openCode({ cost: 'estimate' })` prefers the library's price whenever it has one.

  - Usage counts the whole input side: OpenCode's uncached `tokens.input` plus its cache reads and writes, with `cacheReadTokens` / `cacheWriteTokens` as subsets (was: the uncached input only, cache tokens dropped from the run total).
  - The model on the row and the `step-finish` frame is the one OpenCode names for the step (`<providerID>/<model id>`).
  - `OpenCodeRunResult.usage` (and the usage on the turn's last message) is summed from the turn's own calls, not read from the store: each milestone carries its share and a durable run journals it, so a run resumed in another process reports the whole run. It now carries `cacheReadTokens`, `cacheWriteTokens` and `reasoningTokens`.
  - core: `ModelPriceResolver` (run-time price lookup that seeds a missing row as boot pricing does), `resolveUsageCost`, a `'title'` usage purpose, and more us-gov-west-1 Bedrock prices in the built-in table (Amazon Nova Micro/Lite/Pro, Titan Text Embeddings V2, Meta Llama 3 8B/70B, OpenAI gpt-oss-20b/120b, NVIDIA Nemotron, xAI Grok 4.6), from the AWS Price List.

## 0.1.2

### Patch Changes

- [#344](https://github.com/DavideCarvalho/nestjs-agent/pull/344) [`e66d435`](https://github.com/DavideCarvalho/nestjs-agent/commit/e66d4353da2df32fa1bfc0937d14481769d77742) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The estimated cost now reaches the usage ledger, and the quota counts it.

  For a provider that reports no cost (Bedrock, or OpenAI and Anthropic called directly), the loop's estimate (tokens times the price row) reached only the stream frame and `agent_message.usage.costUsd`. `agent_token_usage.cost_usd` stayed NULL, so the quota's USD windows read $0.

  - **The ledger stores the estimate.** `agent_token_usage.cost_usd` now holds it, marked by the new `cost_source` column (`'provider' | 'estimate'`). The boot schema heal adds the column (Drizzle and MikroORM), so no app migration is needed. A provider-reported cost is unchanged, still wins, and is stamped `'provider'`. An unpriced turn keeps both columns NULL. Chat, structured-output and follow-up usage rows are covered.
  - **SPI.** `RecordUsageInput.costSource` and `CostSource` are new. `quotaToday` / `usageBetween` return `UsageTotals` (`{ usedTokens, costUsd, estimatedCostUsd? }`), where `costUsd` includes estimates. `sumUsage` is new.
  - **Quota.** The USD windows count estimates by default, because a USD ceiling on a provider that reports no cost would otherwise never block. `quota: { limits, countEstimatedCost: false }` counts provider-reported cost only.

## 0.1.1

### Patch Changes

- [#324](https://github.com/DavideCarvalho/nestjs-agent/pull/324) [`d516616`](https://github.com/DavideCarvalho/nestjs-agent/commit/d51661667fe477f11c2cca25483ded3678d53f96) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Docs: explain what `tools.url` must point at — it is passed verbatim to OpenCode and called back by the OpenCode server, so it is an address of the app as seen from there (same machine / Compose / Kubernetes / public URL), must reach a process that mounts controllers, and every process behind it needs the same `tools.secret`.

## 0.1.0

### Minor Changes

- [#323](https://github.com/DavideCarvalho/nestjs-agent/pull/323) [`52703f0`](https://github.com/DavideCarvalho/nestjs-agent/commit/52703f077f5ae22ade28fbb5838d6591abcadc6e) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `hostContext`: the host's own JSON facts about a send (where it came from, where its answer goes) travel on `AgentRunInput` through `AgentService.chat`, the queue (persisted by the in-memory, Drizzle and MikroORM stores; never on the wire view) and the durable journal. The OpenCode engine's host gets lifecycle hooks: `onAsk`, `onUi`, `beforeSettle` (append components, word a failure) and `onSettled` (deliver, record spend), each seeing the run's `hostContext`. `CreateThreadInput.agentName` lets a store start a thread on the send's agent; `AgentRunner.runIdFor` lets a runner name its runs (the OpenCode engine's `runId` setting); `openCodeDurable({ durable: { start, startError } })` sets each turn's workflow start options (tags, search attributes, concurrency quota) and maps a refused start. The host also gets `startOptions`/`startError` (durable starts from DI), `promptFor` (what the session is prompted with), `reuse` (keep the thread's session or open a new one) and `beforePrompt` (update the session every turn: model, permissions, tools). `ChatParams.authorized` lets a host send into a thread it already decided the actor may write (a shared channel thread); the OpenCode engine adds `pushToSession` (trusted pushes) and `liveRuns()`. Engine tokens are `Symbol.for` (shared by the main and `/durable` bundles) and `OPENCODE_TURNS` resolves the engine's turn steps from outside — inject it, not the class.

- [#317](https://github.com/DavideCarvalho/nestjs-agent/pull/317) [`8ba61cd`](https://github.com/DavideCarvalho/nestjs-agent/commit/8ba61cda56bb3c158284d5539325d971f332374f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Engines: `AgentModule.forRoot({ engine })` runs turns on something other than the library's loop, and `@dudousxd/nestjs-agent-opencode`'s `openCode({ host })` runs them on OpenCode 2 sessions — the library's routes, stream protocol, approvals, questions and queue over OpenCode's loop. `model` is optional when an engine is set. Durable turns via `openCodeDurable()` (`/durable`); approval policy, `@AiTool`s over MCP, skills, memory and regenerate reach the OpenCode session. `AgentMcpServerModule`'s `context` option ties a tool call to the conversation it serves (from `_meta`); under OpenCode, tools' `ctx.emitUi` reaches the turn, `remember` writes memory, and `keyValueOpenCodeSessionStore` shares sessions across processes.

- [#323](https://github.com/DavideCarvalho/nestjs-agent/pull/323) [`40c040f`](https://github.com/DavideCarvalho/nestjs-agent/commit/40c040f43b2f8255b97104bef1c0159731d00842) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The OpenCode engine serves the module's tools on its own MCP endpoint (`POST <agent path>/opencode/mcp`, mounted by the engine through the new `AgentEngine.controllers`), not on `AgentMcpServerModule`: `tools: { url, secret, ttlMs }` replaces `tools.headers`, and the engine registers each session with a token it signs (actor, OpenCode server, expiry). A call runs only while the token's actor has a turn running on the calling session, under the agent's and persona's allow-list and roles, and an `action` only against an approval granted in that turn — one call per approval — so a caller that skips OpenCode's permission rules is refused. `remember` is served there only and no longer added to the shared tool registry (`AgentMcpServerModule`, `/tools`). A form answer or skip sent to an approval is refused with a 409 (`OpenCodeReplyMismatchError`) instead of rejecting the action. OpenCode's own error text reaches the stream only outside production (the library's `streamFailure` rule); it is logged and on the run row everywhere. The event stream counts as open once the server's first event arrives, so nothing a prompt causes is lost to a slow connect. A durable `begin` run again after a crash writes the run's user message once.
