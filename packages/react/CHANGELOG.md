# @dudousxd/nestjs-agent-react

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
