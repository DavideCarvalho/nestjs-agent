# `@dudousxd/nestjs-agent-react`

> 🪺 Part of the [Aviary](https://davidecarvalho.github.io/aviary) · the React frontend for [`@dudousxd/nestjs-agent`](https://www.npmjs.com/package/@dudousxd/nestjs-agent).

`useAgentChat` wraps the Vercel **AI SDK v7** `useChat` with a transport for the agent's `/agent/chat`
SSE, plus threads, personas, quota, cancel, and human-in-the-loop approve/reject and answer/skip. `useChatTranscript`
turns the streamed messages into a renderable model — grouped parts, derived values, actions as state
machines — and the chat components are one rendering of it. Optional rich-markdown subpath.

## Install

```bash
pnpm add @dudousxd/nestjs-agent-react @ai-sdk/react ai react
```

## Use

```tsx
import { useAgentChat, MessageList, ChatInput } from '@dudousxd/nestjs-agent-react';

function Chat() {
  const chat = useAgentChat(); // same-origin, `/agent` — no provider needed
  return (
    <>
      <MessageList messages={chat.messages} status={chat.status} />
      <ChatInput onSubmit={(text) => chat.sendMessage({ text })} />
    </>
  );
}
```

`useAgentChat` does the wiring itself: give it a `threadId` and it loads that thread's history and
re-attaches to a turn still streaming on it (`history: false` / `resume: false` opt out); it gates
sends on the reported quota; approvals and question sets in the transcript are actionable with no
handlers passed. On top of the AI SDK chat it returns:

| On `chat` | What it is |
|---|---|
| `transcript` | `useChatTranscript` already bound to the chat — approve/reject/answer/skip, stop, fork, regenerate, the tool catalog, and timestamps/usage read from message metadata. Override any of it with `useAgentChat({ transcript: { … } })`. |
| `composer` | `{ text, setText, files, canSend, blockedBy, submit() }` — `files` is `useAttachments` on the chat's backend; `submit()` sends the draft with the ready files attached and clears both — while a turn runs it QUEUES it (see *Typing ahead*), and `submit({ mode: 'interrupt' \| 'queue' })` picks what happens mid-turn for that one send; `blockedBy` is `'empty' \| 'busy' \| 'uploading' \| 'quota'` (`'busy'` only with `whileRunning: 'block'`). |
| `queue` | `{ items, paused, isSupported, add(text, { attachments?, mode? }), remove(id), interrupt(id), edit(id, text), move(id, index), clear(), resume(), error }` — messages sent mid-turn, waiting server-side for the running turn to settle. |
| `models` | `{ list, providers, selected, pinned, locked, select(id), pinToThread(id) }` — loaded the first time `list` is read. |
| `quota` / `blocked` | `useQuota`'s state, and the window blocking sends (the `blocked` option overrides it). |
| `approve` / `reject` / `answer` / `skip` | `({ toolCallId, … })` — the same object shape the transcript's handlers take. |
| `fork` / `truncateFrom` / `promote` | `({ messageId, threadId? })` / `({ threadId? })`, defaulting to this chat's thread. |
| `cancel`, `regenerate`, `getThreadId`, `backend`, `runId`, `activeRunId`, `isLoadingHistory`, `connection`, `background` | — `isLoadingHistory` is already `true` on the first render with a `threadId`, so a page can show a skeleton instead of flashing its empty state |

Threads (list, rename, delete) are `useThreads()`; the granular hooks stay the escape hatch.

### Configure the connection once: `<AgentProvider>`

Every hook (`useAgentChat`, `useThreads`, `useModels`, `useAgents`, `useQuota`, `useToolCatalog`,
`useMessageFeedback`, `useAttachments`) talks to the enclosing provider's backend unless handed a
`backend` of its own. Without a provider they share one same-origin client on `/agent`.

```tsx
import { AgentProvider } from '@dudousxd/nestjs-agent-react';
import { mediaAttachments } from '@dudousxd/nestjs-agent-react/media';

<AgentProvider
  baseUrl="https://api.example.com" // origin only; default '' (same origin)
  path="api/agent"                  // AgentModule's `path` + global prefix; default 'agent'
  credentials="include"
  getHeaders={() => ({ 'X-XSRF-TOKEN': readCookie('XSRF-TOKEN') })}
  attachments={{ upload: mediaAttachments() }} // optional
  genui={{ registry, catalog }}                // optional — same props as <GenuiProvider>
>
  <App />
</AgentProvider>
```

`<AgentProvider backend={myBackend}>` takes any `AgentBackend` instead of the connection props.
`useAgentBackend()` returns the backend in scope, for your own calls.

## Bring your own UI

The package is **headless by design**, in four layers, and only the top one renders anything:

| Layer | Owns | Renders? |
|---|---|---|
| `AgentClient` | The REST calls — threads, quota, attachments, approve/reject/answer/skip | No |
| `AgentChatTransport` + `useAgentChat` | SSE parsing, resume/reconnect, thread state, HITL routing | No |
| `useChatTranscript` / `useTranscriptItem` | The transcript model — grouped parts, per-message derived values, action state machines, windowing, stick-to-bottom | No |
| `useComposerAutocomplete` | The composer's completion model — which trigger the caret is in, the query, the filtered items, the highlight, what a pick does to the text and caret | No |
| `MessageList` / `MessageItem` / `ChatInput` / `AgentMarkdown` | One rendering of that model | Yes — and optional |

A host with its own design system drives the model and writes its own markup; it never reimplements
tool grouping, the edit machine, or the copy flash, and it never imports `MessageList`.

### The transcript model

```tsx
import { useAgentChat, useChatTranscript } from '@dudousxd/nestjs-agent-react';

function Chat() {
  const chat = useAgentChat();
  // `chat.transcript` is this, pre-wired; `useChatTranscript` directly for any AI SDK chat.
  const transcript = useChatTranscript({
    messages: chat.messages,
    status: chat.status,
    editable: true,
    onEditSubmit: ({ text }) => chat.sendMessage({ text }),
    onFork: ({ messageId }) => chat.fork({ messageId }),
    onStop: () => chat.cancel(),
  });

  return (
    <div {...transcript.scroll.getContainerProps()} className="my-scroller">
      {transcript.window.canLoadEarlier ? (
        <button onClick={transcript.window.loadEarlier}>
          {transcript.window.hiddenCount} earlier
        </button>
      ) : null}

      {transcript.items.map((item) => (
        <article key={item.id} className={item.isUser ? 'bubble-user' : 'bubble-assistant'}>
          {item.blocks.map((block) => {
            if (block.kind === 'text') return <MyMarkdown key={block.key}>{block.text}</MyMarkdown>;
            if (block.kind === 'tools') return <MyToolGroup key={block.key} parts={block.parts} />;
            return (
              <MyDisclosure key={block.key} open={block.isOpen} onToggle={() => block.toggle()}>
                {block.text}
              </MyDisclosure>
            );
          })}
          {item.copy.available ? (
            <button onClick={item.copy.copy}>{item.copy.copied ? 'Copied' : 'Copy'}</button>
          ) : null}
          {item.usage ? <span>{item.usage.costLabel} · {item.usage.tokensLabel}</span> : null}
        </article>
      ))}

      {transcript.scroll.showJumpToLatest ? (
        <button onClick={transcript.scroll.scrollToBottom}>Jump to latest</button>
      ) : null}
      {transcript.stop.available ? (
        <button onClick={transcript.stop.stop}>
          {transcript.stop.isStopping ? 'Stopping…' : 'Stop'}
        </button>
      ) : null}
    </div>
  );
}
```

| On the instance | What it is |
|---|---|
| `items` | The mounted window, oldest first. Each item carries `blocks`, `text`, `usage`, `timestamp`, `isStreaming`, `isLastAssistant`, and its action machines. |
| `items[i].blocks` | `{ kind: 'text' \| 'reasoning' \| 'tools' \| 'sources' \| 'elicitation' \| 'ui' }`. A `ui` block is a component the server pushed (`{ id, component, props, version, toolCallId }`) — draw it with `<GenerativeUI>` (below) or look `component` up in your own registry. A `tools` block is a run of CONSECUTIVE tool parts — any other part between two calls (including a `step-start` marker) ends the run. A `reasoning` block carries `isOpen`/`toggle`, open while it streams. A `sources` block appears only under `sources: true`, an `elicitation` block only under `onAnswer` — see below. |
| `items[i].blocks[n]` (`tools`) | Also carries `calls`: the same parts, each with `{ toolCallId, name, toolKind, parentId, children, approval, isAwaitingApproval, approve, reject, error }`, and `roots`: the same calls as a tree (a call nested under another by the stream's `parentId` sits in its parent's `children`). `approval` is `{ approver, expiresAt, reason, status, remember, decidedBy, decidedVia, decisionReason }` when the runner said who has to decide, else `null` — `status` is `pending` / `approved` / `rejected` / `expired`. |
| `items[i].copy` | `{ available, copied, copy() }` — `copied` flashes for `copyResetMs` (default 1500). |
| `items[i].edit` | `{ available, isEditing, draft, canSave, start(), cancel(), setDraft(), save(), getTextareaProps() }`. The prop-getter focuses with the caret at the end, saves on Enter, cancels on Escape. |
| `items[i].fork` / `.regenerate` | `{ available, run() }`. Regenerate is offered on the last assistant message only. |
| `items[i].usage` / `.timestamp` | `{ totalTokens, costLabel, tokensLabel }` / `{ relative, absolute, date }` — the derivations, not the markup. |
| `window` | `{ visibleCount, hiddenCount, canLoadEarlier, loadEarlier(), showAll() }`. |
| `scroll` | `useStickToBottom` — `{ isAtBottom, showJumpToLatest, scrollToBottom(), getContainerProps() }`. |
| `stop` | `{ available, isStopping, stop() }` over `useAgentChat`'s `cancel`. |
| `showEmptyState` / `showTypingIndicator` / `showFollowUps` | List-level "should this be on screen" booleans. |

`useTranscriptItem({ message })` is the single-message half, for a host that lays out the list
itself. `MessageItemView({ item })` is the default markup for one modelled item — drive the model
yourself and still render the shipped bubble.

### Talking about tool calls

Tools declare how they are spoken about on the server (`@AiTool({ presentation })`, served by
`GET /agent/tools`). `useToolCatalog` fetches that once per client + agent and shares it; hand the
catalog to the transcript and every tool call carries a `description`, and every tool block an
`activity` grouping:

```tsx
const chat = useAgentChat();
const { catalog } = useToolCatalog(); // the provider's backend; `{ backend, agent }` to override
// Several agents on one surface: every tool the actor reaches through any of them.
const all = useToolCatalog({ agent: ALL_AGENTS }); // GET /agent/tools?agent=*
const transcript = useChatTranscript({ messages: chat.messages, status: chat.status, toolCatalog: catalog });

// in a `tools` block:
block.activity.map((group) => (
  <li key={group.key} data-state={group.status}>
    <MyGlyph name={group.icon} /> {group.phrase} {group.count > 1 ? `×${group.count}` : null}
  </li>
));
```

| Helper | What it gives you |
|---|---|
| `call.description` / `describeToolCall(part, catalog)` | `{ status, phrase, label, icon, tone, detail, confirm, result, error }` — `status` is `running` / `awaiting-approval` / `done` / `failed` / `denied`; `confirm` is the approval prompt filled from the input; `result` the output read through the declared view (`metrics` readings, `table` rows as text, `log` lines, `note` text). |
| `groupToolActivity(block.roots, { catalog, keyOf?, expandNested?, hideCorrected? })` | Calls folded by key ("Database query ×3"), worst status first, latest phrase, `innerCount` of nested calls. `expandNested` replaces a parent (a code-mode `execute`) with the calls it made; `keyOf` groups by anything else (e.g. `github:search`). |
| `phraseFor` / `fillTemplate` / `readPath` | The template engine: `{dotted.path}` over the input; an empty slot collapses with its leading space; an undescribed tool reads `Working` / `Done`, never its name. |
| `resolveResultView` / `inferResultView` | A tool output through a view, as plain data — never a serialized payload. |
| `toolCallState` / `correctedCallIds` / `isActionCall` | Per-call status, and which failures the model later corrected. |

### Where the answer came from

RAG persists its retrieval as an auto-executed tool call whose output is `{ passages }` — inject
mode records it as `retrieve`, `createRetrievalTool` under whatever name the host chose. Pass
`sources: true` and the model lifts those parts into a `sources` block, aggregated by origin:

```tsx
const transcript = useChatTranscript({ messages, status, sources: true });
// block.kind === 'sources' → { query, sources: [{ label, passageCount, topScore, passages }], passageCount }
```

Detection is structural rather than by tool name, so a renamed retrieval tool still renders as
provenance. It is off by default: with it off those parts stay in the tool run, where an existing
tool renderer already receives them.

### When the run stops for a person

Two things park a run on a human, and both are state on the transcript — not a modal you wire
yourself, and not a panel beside the conversation.

**A question set.** An agent's configured intake, or the model's own `ask` tool, posts questions and
parks the run until someone settles them. Pass `onAnswer` and the model lifts that tool part out of
the tool run into an `elicitation` block:

```tsx
const transcript = useChatTranscript({
  messages, status,
  onAnswer: (toolCallId, answers) => chat.answer({ toolCallId, answers }),
  onSkip: (toolCallId) => chat.skip({ toolCallId }),
});

// block.kind === 'elicitation' →
// { toolCallId, preamble, questionCount, isPending, isValid, outcome, error,
//   questions: [{ id, prompt, description, input, position, multiple, selected, value, error,
//                 isPristine, setValue(raw),
//                 options: [{ value, label, hotkey, isSelected, isDefault, select() }] }],
//   answer: { available, isSubmitting, run() }, skip: { … } }
```

**Typed questions.** A question with `input` asks for a value instead of a pick — `input.type` is
`text` · `textarea` · `number` · `boolean` · `date` · `email` · `url` · `select` (a pick from
`options` again), with optional `placeholder`, `required`, `min`, `max` and `pattern`. `options` may
be empty for one. Render the control from `input.type` and hand whatever it produces to
`question.setValue(raw)`: it is coerced with `coerceAnswer` to the canonical strings the wire
carries (numbers as decimals, booleans as `"true"`/`"false"`, dates as `YYYY-MM-DD`). `question.error`
is the server's own verdict on the current selection (`validateAnswer`), and `block.isValid` is all
of them — the answer route answers `400` with the same message for anything it would refuse.

```tsx
{q.input?.type === 'number' ? (
  <input type="number" value={q.value} placeholder={q.input.placeholder}
         min={q.input.min} max={q.input.max} onChange={(e) => q.setValue(e.target.value)} />
) : q.input?.type === 'boolean' ? (
  <input type="checkbox" checked={q.value === 'true'} onChange={(e) => q.setValue(e.target.checked)} />
) : null}
{q.error && !q.isPristine ? <small role="alert">{q.error}</small> : null}
```

Every option the agent pre-picked comes back as `isDefault` and starts `isSelected`, so confirming
is enough. `answer.run()` submits **only the questions the user touched** — the rest are omitted on
purpose, so the server applies the same defaults it showed and the settled row still records which
ones a human actually decided. A settled set keeps its block (`isPending: false`, `outcome` filled,
`selected` showing what was chosen), so one piece of markup renders both states.

Detection is structural rather than by tool name — an intake and an `ask` persist under whatever
name their row holds.

**Decisions settle through the backend by default.** `onApprove`, `onReject`, `onAnswer` and
`onSkip` left undefined are NOT "off": each defaults to the in-scope backend's call (the enclosing
`<AgentProvider>`'s `approveToolCall` / `rejectToolCall` / `answerToolCall` / `skipToolCall`), so a
parked approval or question set is actionable with no wiring. Pass your own handler to route it
elsewhere, `null` to drop one affordance (`onAnswer: null` keeps question sets as plain tool
cards), or `readOnly: true` for a surface nobody acts on — an audit view, a shared or archived
conversation. `readOnly` keeps parked approvals and question sets rendered (with their outcome)
but offers no approve / reject / answer / skip, edit, fork, regenerate or stop, whatever is in
scope; `<MessageList readOnly>` and `useAgentChat({ transcript: { readOnly: true } })` take it too.

**A tool call awaiting approval.** Every call in a `tools` block carries its own decision:

```tsx
{block.calls.map((call) => (
  <MyToolCard key={call.toolCallId} part={call.part}>
    {call.isAwaitingApproval ? (
      <>
        <button onClick={call.approve.run} disabled={call.approve.isSubmitting}>Approve</button>
        <button onClick={call.reject.run}>Reject</button>
        {call.error ? <p role="alert">{call.error}</p> : null}
      </>
    ) : null}
  </MyToolCard>
))}
```

An `action` tool's input lands and its output never follows on its own — the loop waits for a person
between the two — so a call stuck at `input-available` IS the pending approval. A question set parks
the same way and is deliberately excluded: approving one settles nothing.

`call.approve.run({ remember: true })` approves this tool for the rest of the thread (the server
stops asking); `call.approval` says who has to decide and, once settled, who did and through what.
For a request with an expiry, `useApprovalCountdown(call.approval?.expiresAt)` ticks the time left
(`{ remainingMs, isExpired }`, headless — pair it with `formatElapsed`):

```tsx
function ApprovalDeadline({ expiresAt }: { expiresAt: string | null }) {
  const { remainingMs, isExpired } = useApprovalCountdown(expiresAt);
  if (remainingMs === null) return null;
  return <span>{isExpired ? 'Expired' : `${formatElapsed(remainingMs)} left`}</span>;
}
```

A refused settlement (403 "not your thread" or "not your approval", 410 "expired", a network failure) lands on `block.error` /
`call.error` with the affordance still live, rather than escaping as an unhandled rejection. Render
it — a button that silently does nothing is indistinguishable from a broken one.

### When a run fails

The server closes a failed run's stream with `event: error` + `{ code, message }`. `chat.error`
carries the message; `chat.runError` carries the whole frame — `{ code, message, runId? }`, `null`
again once the next attempt starts — so the app words each failure itself. The library renders
nothing for it:

```tsx
import { isRunNotActiveError } from '@dudousxd/nestjs-agent-react';

const FRIENDLY: Record<string, string> = {
  replay_diverged: 'This answer was interrupted by an update. Send your message again.',
  model_no_output: 'The model returned nothing. Try again.',
  run_failed: 'Something went wrong on our side. Try again.',
};

{chat.runError && <p role="alert">{FRIENDLY[chat.runError.code ?? ''] ?? chat.runError.message}</p>}
```

`AGENT_RUN_ERROR_CODES` lists the codes this library's loop sends (`quota_exceeded`,
`output_rejected`, `structured_output_invalid`, `replay_diverged`, `model_no_output`, `run_failed`).
In production the `message` of the last three is one generic sentence — the error itself stays in
the server's log.

A failed turn leaves its thread usable: the next send starts a new turn. What it cannot do is
answer a card the dead turn left on screen. `approve` / `reject` / `answer` / `skip` on one reject
with an `AgentHttpError` whose `status` is `409` and `code` is `run_not_active`:

```tsx
try {
  await chat.approve({ toolCallId });
} catch (error) {
  if (isRunNotActiveError(error)) showStale('This request expired with its turn — send it again.');
  else throw error;
}
```

On the transcript model the same refusal is `call.errorCode === 'run_not_active'` (and
`elicitation.errorCode`) next to `call.error`, the server's message.

### Completing as you type

`useComposerAutocomplete` is the state machine behind a `/`-style menu in the composer. It is
source-agnostic on purpose: a host supplies **sources**, each with a trigger character, and the same
machine drives `@` for a mention as drives `/` for a command. Nothing in it knows what a skill is.

```tsx
import { useComposerAutocomplete, type AutocompleteSource } from '@dudousxd/nestjs-agent-react';

const skills: AutocompleteSource = {
  id: 'skills',
  label: 'Skills',
  trigger: '/',
  position: 'start',
  getItems: async (query, signal) => {
    const rows = await fetch(`/agent/skills?q=${query}`, { signal }).then((r) => r.json());
    return rows.map((row) => ({ id: row.name, label: row.name, description: row.description }));
  },
  // The endpoint already matched; re-filtering here would undo it.
  filter: (items) => items,
};

const autocomplete = useComposerAutocomplete({ value: draft, onValueChange: setDraft, sources: [skills] });
```

| On the instance | What it is |
|---|---|
| `isOpen` / `source` / `trigger` / `query` | Whether the caret is inside a live trigger token, and which one |
| `items` / `activeIndex` / `activeItem` | The filtered candidates and the highlight |
| `isLoading` / `error` | An async source that has not answered, and one that threw |
| `highlight(i)` / `moveHighlight(±1)` | Move the highlight; `moveHighlight` wraps at both ends |
| `accept(item?)` | Insert — the highlighted item by default. A click handler calls this directly |
| `dismiss()` | Close for the token being typed, without touching the text |
| `getInputProps()` | The textarea's combobox wiring (`role`, `aria-expanded`, `aria-controls`, `aria-activedescendant`) plus the keys the menu owns |
| `getListboxProps()` / `getOptionProps(i)` | `role="listbox"` / `role="option"` with the ids `aria-activedescendant` points at |

**The trigger rule is per source, and there is no default.** `position: 'start'` fires only as the
first character of the input — `/deploy` is a command, `src/foo` and `and/or` are not. `position:
'word'` fires at the start of any word, which is how `@ada` reads mid-sentence while `ada@example`
does not. Getting this wrong breaks the thing people type most, so the source has to say.

**Insertion** replaces the token, keeps the trigger, and appends a space: `/roll` + *rollback* →
`/rollback ` with the caret after the space, and anything already to the right of the caret is left
where it was. The space both closes the menu and puts the caret where the command's argument goes,
so typing straight on is free text. A source that wants the menu to stay open sets `insertSuffix: ''`.

**Keys.** ↑/↓ move (wrapping), Enter and Tab accept, Escape closes for that token. Shift+Tab is left
alone — a completion menu is not a focus trap. Every key the menu takes is `preventDefault`ed, which
is how a composer that sends on Enter knows to stand down:

```tsx
function onKeyDown(event) {
  inputProps.onKeyDown(event);
  if (event.defaultPrevented) return;   // the menu took it
  if (event.key === 'Enter' && !event.shiftKey) submit();
}
```

**Async sources** are asked per query with an `AbortSignal`; an answer to a query the user has
already typed past is discarded rather than allowed to overwrite a newer list, and its request is
aborted. A source that throws leaves the draft alone, reports itself on `error`, and calls `onError`
— typing and sending carry on.

**Skills are one source, not a special case.** `createSkillsSource` is `GET /agent/skills` — the
scope-resolved list of what THIS actor can invoke, built by the same call that offers the catalog to
the model, so a `/` menu and the agent's own reach cannot drift apart:

```tsx
import { createSkillsSource, useAgentChat } from '@dudousxd/nestjs-agent-react';

const chat = useAgentChat({ onThreadCreated: setThreadId });
// Identity-stable so the list is read once per thread, not once per keystroke.
const sources = useMemo(
  () => [createSkillsSource({ backend: chat.backend, getThreadId: () => threadId })],
  [chat.backend],
);
```

Each item carries its provenance twice: as a `hint` the rendered row right-aligns
(`tenant:berlin · overrides global`), and raw on `data` as `{ scope, shadows? }` for a host that
wants to draw it differently. `shadows` is present only on a clash, so "there is no org default" and
"there is one and yours wins" stay distinguishable. The list arrives ordered most-specific-scope
first, then alphabetically — that order IS the precedence, and it is passed through untouched. The
type-ahead narrows the list it received; it never re-derives which skills apply.

The shadcn `ChatComposer` wires all of this for you: pass `autocompleteSources` and it renders the
menu (`ChatCommandPalette`, grown into the combobox's listbox) above the composer card.

### Generative UI (`/genui`)

`@dudousxd/nestjs-agent-react/genui` draws server-pushed components (`ui` frames, persisted `ui[]`)
with YOUR renderers. Headless: it adds no element and no style — only what your registry renders.
Set it up once, at the root; `MessageItem` / `MessageList` then draw every pushed component with no
`renderUi` of their own:

```tsx
import { GenuiProvider, type GenuiRegistry } from '@dudousxd/nestjs-agent-react/genui';
import { catalog } from './catalog'; // optional: the same file the server uses (@dudousxd/nestjs-agent-core/genui)

const registry: GenuiRegistry = { DataTable: MyTable, Chart: MyChart, Card: MyCard, Text: MyText };

<GenuiProvider
  registry={registry}
  catalog={catalog}
  resolveComponent={(name, version) => loadTenantComponent(name, version)}
  fallback={({ reason, item }) => <UnknownComponent name={item.component} reason={reason} />}
  loading={<Skeleton />}
>
  <App />
</GenuiProvider>;
```

| Prop | |
|---|---|
| `registry` | Component name → your renderer. It receives the props spread (and `children` as a tree layout node). |
| `catalog?` | Validate props before drawing (`catalog.validateSync` when it can, so no placeholder flashes). Components the catalog does not know render unvalidated. |
| `resolveComponent?(name, version)` | For components the registry lacks, e.g. a tenant's own, at the exact version a message was rendered with. Sync or async, cached per resolver/name/version. |
| `fallback?` | A node, or `({ reason: 'unknown' \| 'invalid' \| 'error', item, issues?, error? }) => node`. Default: nothing. |
| `loading?`, `onError?` | While a resolver or async validation is pending; a renderer threw (each item has its own error boundary). |
| `treeRenderer?` | Draws a whole `genui:tree` frame (e.g. json-render, below). Default: node by node through `registry`. |

`<GenerativeUI part={block} />` draws one component (a transcript `ui` block, a `data-ui` message
part, or a stored `{ id, component, props, version? }`) with the provider's settings; any of the
props above passed to it win over the provider's. An explicit `renderUi` on `MessageItem` still
wins too, and `useAmbientRenderUi()` (main entry) hands a custom transcript the provider's renderer.

A `genui:tree` frame (tree mode) is drawn node by node through the same registry, catalog and
fallbacks, each node in its own boundary. `useGenerativeUI(part, options?)` returns the state
(`ready` with `Component`/`props`, `loading`, `problem`) for your own chrome, defaulting to the
provider's settings; wrap it in `<GenerativeUIScope>` when it may draw a tree.

**json-render** (optional peer `@json-render/react` >= 0.21): import `GenuiProvider` from
`@dudousxd/nestjs-agent-react/genui/json-render` instead — the same provider plus
`jsonRender={myJsonRenderRegistry}` (or `jsonRender` alone, to derive one from `registry`), which
draws tree frames through json-render's `Renderer`. `JsonRenderTree`, `jsonRenderTree`,
`toJsonRenderRegistry` and `treeToJsonRenderSpec` are exported for hand wiring.

### Designed components, as copy-in source

`MessageList`/`MessageItem`/`ChatInput` are deliberately minimal. For a styled, accessible chat
surface over the same model — welcome state with mode pills, a composer card with a context strip,
grouped tool cards, a reasoning disclosure, provenance, follow-ups, stick-to-bottom — there is a
[shadcn registry](https://davidecarvalho.github.io/aviary/docs/agent/guides/chat-components) whose
components are copied into your project rather than imported from here:

```bash
npx shadcn@latest add https://davidecarvalho.github.io/aviary/r/agent-chat.json
```

Tailwind classes belong in the tree Tailwind already scans, which is why they ship as source and not
as an export of this package.

### `useAgentChat` on its own

```tsx
import { useAgentChat } from '@dudousxd/nestjs-agent-react';
import { isTextUIPart, isToolUIPart } from 'ai';

function CustomChat({ threadId }: { threadId?: string }) {
  const chat = useAgentChat({
    // Omit the key entirely when absent — `UseAgentChatOptions` is built with
    // `exactOptionalPropertyTypes`, so an explicit `threadId: undefined` doesn't type-check.
    ...(threadId !== undefined ? { threadId } : {}),
    agent: 'support',
    // A `threadId` loads its history and re-attaches to a turn still streaming — by default.
    onThreadCreated: (newThreadId) => router.replace(`/chat/${newThreadId}`),
    // Fires once per run when the SERVER is done writing (title + terminal state persisted) —
    // the right signal to refetch a thread list/sidebar; `onFinish` only means "a turn rendered".
    onRunSettled: ({ status }) => {
      if (status === 'completed') refetchThreadList();
    },
    // The server named (or renamed) the thread mid-stream — update the header now.
    onTitle: (title) => setHeaderTitle(title),
    // Every data part as it arrives: pushed `data-ui` components, `data-approval-requested`, …
    onData: (part) => analytics.track(part.type),
  });

  return (
    <div className="my-chat-shell">
      {chat.messages.map((message) => (
        <div
          key={message.id}
          className={message.role === 'user' ? 'my-bubble-user' : 'my-bubble-assistant'}
        >
          {message.parts.map((part, i) => {
            if (isTextUIPart(part)) return <p key={i}>{part.text}</p>;
            if (isToolUIPart(part)) return <MyToolCard key={i} part={part} />;
            return null;
          })}
        </div>
      ))}
      <MyComposer
        disabled={chat.status === 'streaming'}
        onSubmit={(text) => chat.sendMessage({ text })}
      />
    </div>
  );
}
```

`sendMessage` and `regenerate` refuse a turn while one is already in flight, and a resume never
attaches to a run this session is already streaming. The AI SDK keeps one in-flight response per
chat and decides whether it replaces the list's last entry or is appended by looking at that last
entry alone, so two overlapping turns append alternating copies of each other and the list ends up
with several entries under one id — React's "two children with the same key". A composer that
disables itself while busy never noticed; a double-submitted one, and StrictMode's doubled resume
effect, did.

`chat` is the AI SDK v7 `useChat` return value (`messages`, `status`, `sendMessage`, `stop`, …) spread
together with the extras in the table above.
`MyToolCard`'s `part` prop above types as the exported `AnyToolUIPart` (`ToolUIPart | DynamicToolUIPart`
— `MessageItem` uses the same union for its own `renderToolPart` callback).

### Your own backend (`AgentBackend`)

Everything the hooks ask of a server goes through one interface, `AgentBackend`: start a turn
(`openChatStream`), attach to a streaming run (`resumeChatStream`), cancel, list/get/update/delete
threads — required — plus optional fork/promote/truncate, approve/reject/answer/skip, upload, tools,
skills, quota and message feedback. `AgentClient` (fetch over this library's routes) is the default.
An app with its own client, auth scheme or server implements the interface and passes it in:

```ts
import type { AgentBackend } from '@dudousxd/nestjs-agent-react';

const backend: AgentBackend = {
  async openChatStream({ body, headers, signal }) {
    const res = await fetch('/api/chat', {
      method: 'POST',
      credentials: 'include',
      headers: { 'content-type': 'application/json', ...csrfHeader(), ...headers },
      body: JSON.stringify(body),
      signal,
    });
    if (!res.ok || !res.body) throw new Error(`chat failed: ${res.status}`);
    return { body: res.body }; // SSE bytes in docs/stream-protocol.md framing
  },
  async resumeChatStream({ runId, after, signal }) {
    const res = await fetch(`/api/chat/${runId}/stream${after ? `?after=${after}` : ''}`, {
      credentials: 'include',
      signal,
    });
    return res.status === 404 ? null : { body: res.body! };
  },
  cancelStream: (runId) => api.chat.cancel(runId),
  listThreads: () => api.threads.list(),
  getThread: (id) => api.threads.get(id),
  updateThread: (id, patch) => api.threads.update(id, patch),
  deleteThread: (id) => api.threads.remove(id),
  setMessageFeedback: (id, input) => api.messages.feedback(id, input),
};

<AgentProvider backend={backend}>…</AgentProvider>; // every hook below uses it
const chat = useAgentChat({ backend }); // or per hook — chat.backend === backend, typed as yours
```

Calling a hook method whose optional backend member is missing throws
`AgentBackendUnsupportedError`. The body a backend receives is `{ message, threadId?, agent?,
attachments?, pageContext?, regenerate? }`; the SSE it returns and the REST shapes are in
[docs/stream-protocol.md](../../docs/stream-protocol.md).

**Cookie session + CSRF with the default client.** `credentials` and `getHeaders` are all it takes —
`getHeaders` runs per request, so a rotated token is picked up:

```tsx
const readCookie = (name: string) =>
  decodeURIComponent(document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`))?.[1] ?? '');

<AgentProvider
  path="api/agent"
  credentials="include" // 'same-origin' (the fetch default) is enough when the API is same-origin
  getHeaders={() => ({ 'X-XSRF-TOKEN': readCookie('XSRF-TOKEN') })}
>
  <App />
</AgentProvider>;
```


### An AG-UI agent (`agUiChatStream`)

`useAgentChat` can drive any [AG-UI 1.0](https://docs.ag-ui.com/spec/1.0) producer — this library's
own (`@adonis-agora/agent/ag-ui`), CopilotKit's, a Python or .NET agent. Put `agUiChatStream` behind
`openChatStream`: it POSTs a `RunAgentInput` (the send's text as the user message, `pageContext`,
`agent` and `model` in `forwardedProps`) and hands the transport the answer re-framed in this
library's stream protocol, so the transcript, tool activity and generative UI render unchanged.

```ts
import { agUiChatStream, type AgentBackend } from '@dudousxd/nestjs-agent-react';

const backend: AgentBackend = {
  ...myBackend,
  openChatStream: (request) =>
    agUiChatStream(request, { url: '/agent/ag-ui', headers: { 'x-csrf-token': csrf } }),
};
```

- Text, reasoning, steps, tool calls and tool results map one to one; `RUN_ERROR` is the stream's
  error, a cancelled outcome writes `cancelled`.
- `CUSTOM` events named `agora.*` (generative UI, title, queue, approvals) become the frames they
  stand for; any other `CUSTOM` is ignored, as the protocol requires.
- An interrupt outcome arrives as a `ui` part, component `AgUiInterrupt`, props `{ interrupts }`:
  answering it is a new run with `resume`, which the app sends through its own backend.
- A send without a `threadId` gets a new one (AG-UI's thread id is the consumer's), returned as
  the stream's `threadId`, so `onThreadCreated` fires as usual.
- Activity (`ACTIVITY_SNAPSHOT` / `ACTIVITY_DELTA`) arrives as a `ui` part, component `AgUiActivity`,
  id `activity:<messageId>`, props `{ activityType, content }`: the whole content each time (the
  delta's JSON Patch applied), so the widget updates in place.
- `content: (body) => parts` sends a file with the message as AG-UI content parts (`image`,
  `document`… by inline `data`), next to the text part.
- `reframeAgUiStream(body, { threadId })` is the re-framing alone, for a backend that fetches itself.

### Typing ahead: the message queue

Send while a turn is still answering and the message waits in the thread's queue — server-side, so
it survives a reload or a closed tab — and runs the moment the turn settles. Nothing to wire:
`composer.submit()` and `sendMessage` queue on their own mid-turn, and the chat attaches to the
queued turn when it starts.

```tsx
const chat = useAgentChat({ threadId });
// …render chat.transcript.items, then what is waiting:
{chat.transcript.queued.map((item) => (
  <div key={item.id} data-state={item.state /* 'sending' | 'queued' | 'paused' */}>
    {item.text}
    {item.remove.available && <button onClick={item.remove.run}>Remove</button>}
  </div>
))}
{chat.queue.paused && (
  <button onClick={() => chat.queue.resume()}>
    Paused ({chat.queue.paused.reason}) — resume
  </button>
)}
```

- `useAgentChat({ whileRunning })`: `'queue'` (default), `'interrupt'` (cancel the running turn and
  run this next), or `'block'` (refuse, `composer.blockedBy === 'busy'` — the old behaviour, also
  what a backend without `enqueueMessage` gets).
- One send can answer differently from the chat's `whileRunning`: `composer.submit({ mode })` and
  `sendMessage(message, { mode })` take `'queue'` or `'interrupt'` — a "send now" button next to a
  plain send that queues. The composer clears its own draft and files either way; with nothing
  running, `mode` means nothing and the message is simply sent. It also lifts `'block'` for that
  send.
- `chat.queue.edit(id, text)`, `move(id, index)`, `remove(id)`, `clear()` change what is waiting;
  `add(text, { attachments, mode })` queues from your own code.
- `chat.queue.interrupt(id)` runs a message that is already waiting NOW: it moves to the head as an
  interrupt and the running turn is cancelled for it, in one server call (the message keeps its id
  and never leaves the queue — do not `remove` and `add` it again). With nothing running it starts
  at once.
- A waiting message's files have the shape a sent message's do: `chat.queue.items[n].files` is
  `MessageFile[]` — what `messageFiles(message)` gives — and `chat.transcript.queued[n].files` is the
  same plus `isImage`, so one file renderer draws both. `attachmentFile(attachment)` makes one from
  an uploaded `MessageAttachment`.
- The queue pauses behind a failed turn (`run_failed`), a Stop (`cancelled`) or an exhausted quota
  (`quota_exceeded`); `chat.queue.paused` says which, `resume()` lifts it. A queue left waiting with
  nothing running is started when the thread loads.
- A send that the server queued anyway (another tab was mid-turn) moves into `chat.queue` instead of
  showing as a sent message.

The wire contract (for a backend of your own) is *Message queue* in docs/stream-protocol.md.

### Reconnecting a dropped stream

A server that numbers its frames (SSE `id:`, as this library's does) can be resumed: when the
connection drops mid-run, the transport re-attaches with `GET <base>/chat/:runId/stream?after=<last
id>`, backing off 0.5s, 1s, 2s… (`reconnect: { maxAttempts, baseDelayMs, maxDelayMs }`, or `false`).
Meanwhile `chat.status` is `'reconnecting'` (a busy status to `useChatTranscript`) and
`chat.connection` says which attempt it is on. If the run ended while the client was away (the
resume answers 404), the hook reloads the thread so the full answer replaces the partial one. After
the last failed attempt the turn ends with an error.

### Thread list and message feedback

```tsx
import { useMessageFeedback, useThreads } from '@dudousxd/nestjs-agent-react';

const { threads, isLoading, rename, remove, refresh } = useThreads();
const feedback = useMessageFeedback({ threadId: chat.getThreadId });

<button aria-pressed={feedback.feedbackOf(message)?.value === 'up'}
        onClick={() => feedback.toggle(message, 'up')}>Helpful</button>
```

`useThreads` refreshes itself when a chat on the same backend creates a thread or settles a run,
and patches a streamed title in place; `rename`/`remove` are optimistic and roll back on failure.
`useMessageFeedback` reads a replayed message's rating from `message.metadata.feedback`, rates
through `POST <base>/messages/:id/feedback`, and maps a message streamed in this session to the row
its run persisted (the live message carries `metadata.runId`).

### Picking a model and an agent

```tsx
const chat = useAgentChat();
const { providers, selected, select } = chat.models; // loaded on first read

<select value={selected ?? ''} onChange={(e) => select(e.target.value)}>
  {providers.map((p) => (
    <optgroup key={p.id} label={p.label}>
      {p.models.map((m) => (
        <option key={m.id} value={m.id} disabled={!m.available}>
          {m.label} {m.badges?.join(' · ')} {m.available ? '' : `(${m.unavailableReason ?? 'unavailable'})`}
        </option>
      ))}
    </optgroup>
  ))}
</select>
```

`chat.models` reads `GET <base>/models?agent=` (models grouped by provider, with badges and
availability; `list` is the same flattened) the first time `list`/`providers` is read. `select(id)`
runs this chat's following sends on it (sent as the body's `model`, which the server applies to
that turn only; switching threads drops the pick); `selected` is the pick, else the thread's pin
(`pinned`), else the server default. `pinToThread(id)` pins it on the thread (`null` unpins) so it
survives reloads, replacing the pick — on a chat with no thread yet, the pin lands when the first
send creates one. `locked` (`{ model, reason? }`) is set when the agent always runs on one model:
`selected` is then that model and `select` does nothing.
`useAgentChat({ model })` controls the model yourself; a single send can override it with
`sendMessage(msg, { body: { model } })`. `useModels()` / `useAgents()` are the standalone hooks
(an agent picker: `useAgents().agents`, sent as `useAgentChat({ agent })`). The server refuses a
model its catalog does not offer as available.

### Quota

```tsx
import { QuotaBlockedError, useQuota } from '@dudousxd/nestjs-agent-react';

const chat = useAgentChat(); // reads GET <base>/quota and gates sends on it
const { quota } = chat;

<meter value={quota.month?.usedUsd} max={quota.month?.limitUsd} />
{chat.blocked ? <p>{chat.blocked.reason}</p> : null}
```

`chat.quota` (and the standalone `useQuota()`) returns every window (`day`, `month`, …) with its
usage and ceilings, and `blocked` when one is exhausted; it re-reads after every run a chat on the
same backend settles. While a window is exhausted, `sendMessage`/`regenerate` reject with
`QuotaBlockedError` (and `chat.composer.blockedBy` is `'quota'`) instead of starting a turn the server
would refuse with `429`. `useAgentChat({ blocked })` overrides the gate (`null` never blocks);
`quota: false` skips the request.

### The transport, standalone

`AgentChatTransport` is a plain AI SDK v7 `ChatTransport` — wire it straight into `useChat` for the SSE
plumbing alone, with none of `useAgentChat`'s thread/quota/approval state:

```ts
import { useChat } from '@ai-sdk/react';
import { AgentChatTransport } from '@dudousxd/nestjs-agent-react';

const transport = new AgentChatTransport({
  path: 'agent', // the default
  getHeaders: () => ({ 'x-actor-id': currentUser.id }),
  onMeta: ({ runId, threadId }) => console.log('turn started', runId, threadId),
});
const chat = useChat({ transport });
```

Beyond text, reasoning and tool calls, the transport maps the rest of the stream vocabulary to AI SDK
data parts, which `useChat`'s `onData` (and `useAgentChat({ onData })`) sees as they arrive:

| Stream frame | Becomes |
|---|---|
| `ui` | a `data-ui` part keyed by the component id (a repeat id updates it in place) |
| `approval-requested` | a `data-approval-requested` part keyed by the call id, plus the SDK's native approval request — the tool part moves to `state: 'approval-requested'` |
| `approval-settled` | a `data-approval-settled` part keyed by the call id — who decided, through what, remembered or not; folded into `call.approval` |
| `title` / `cancelled` | transient `data-title` / `data-cancelled` (never stored on the message); `useAgentChat({ onTitle })` |
| a kind this version does not know | a `data-<kind>` part — forwarded, never dropped |

`parentId` on a tool frame rides the part's `toolMetadata` next to `toolKind`. The full wire
contract — for a backend that serves these routes without this library's loop — is
[docs/stream-protocol.md](../../docs/stream-protocol.md).

### Loading persisted history

`useAgentChat({ threadId })` loads it for you. To seed a chat with history you already have (SSR,
a cache), convert the thread's `StoredMessage[]` and pass it as `initialMessages` — the hook then
skips its own read:

```ts
import { storedThreadToUiMessages } from '@dudousxd/nestjs-agent-react';

const initialMessages = storedThreadToUiMessages(detail.messages);
useAgentChat({ threadId, initialMessages });
```

`storedThreadToUiMessages` merges the store's one-row-per-model-iteration turns (a turn with tool
calls persists as "thinking…" + tool calls, then a separate final-answer row) into ONE `UIMessage` per
conversational turn, matching how the live stream renders — and stamps `metadata.usage` on any turn it
merged. For a single already-atomic row, `storedMessageToUiMessage` maps it 1:1 with no merging.
Persisted reasoning comes back as a `reasoning` part before the text (with its duration), and
persisted pushed components as `data-ui` parts, so a reloaded thread shows what the live one did.

### Attachments

`chat.composer.files` (or `useAttachments()` on its own) is the composer's file tray without the
tray: validation, one upload per file with progress and cancel, retry, image previews, and the
handlers for a file input, a drop zone and paste. `chat.composer.submit()` sends the ready files
with the draft and clears them.

```tsx
const chat = useAgentChat({
  // optional — or `upload: (file, { signal, onProgress }) => myUpload(file)`
  composer: { accept: 'image/*,.pdf', maxBytes: 20 * 1024 * 1024, maxFiles: 5 },
});
const { files } = chat.composer;

<div {...files.dropZoneProps} data-dragging={files.isDragging}>
  <textarea onPaste={files.onPaste} />
  <input {...files.inputProps} hidden ref={pickerRef} />
  {files.items.map((item) => (
    <span key={item.id} data-status={item.status}>
      {item.previewUrl ? <img src={item.previewUrl} alt="" /> : item.name}
      {item.status === 'uploading' ? ` ${Math.round(item.progress * 100)}%` : null}
      {item.error}
      <button onClick={() => files.remove(item.id)}>Remove</button>
    </span>
  ))}
</div>

<textarea value={chat.composer.text} onChange={(e) => chat.composer.setText(e.target.value)} />
<button disabled={!chat.composer.canSend} onClick={() => chat.composer.submit()} />
```

`accept`, `maxBytes` and `maxFiles` default to the server's own limits (`GET <base>/config`, read
once per backend by `useAgentConfig()`), so the composer never repeats them; pass them only to
narrow further. What a send carries is `files.refs` — `{ mediaId }` only, the one shape the server
accepts (each item's full `attachment` is there for display).

An item is `uploading`, `ready`, `error` (retry with `files.retry(id)`) or `rejected` (failed
`accept`/`maxBytes`/`maxFiles` and never uploaded; `error` says why). `remove` cancels an upload in
flight. `messageFiles(message)` reads the files back off any message — live or replayed — with a
`kind` (`image`, `pdf`, `text`, …), the extension and, for replayed ones, the stored `mediaId`.

#### Resumable uploads on nestjs-media (`@dudousxd/nestjs-agent-react/media`)

With `AgentMediaAttachmentsModule` on the server (`@dudousxd/nestjs-agent/media`), one option turns
it on — uploads go in chunks through nestjs-media's tus endpoint, with progress, abort (`remove`)
and retry, on the client's own connection (origin, path, headers, credentials):

```tsx
import { mediaAttachments } from '@dudousxd/nestjs-agent-react/media';

<AgentProvider attachments={{ upload: mediaAttachments() }}>…</AgentProvider>;
const files = useAttachments(); // uploads resumably
```

Headless; `@dudousxd/nestjs-media-client` is an optional peer only this subpath uses. Extending it:

- `mediaAttachments({ chunkSize, retries })` — tuning (the path comes from the client's `path`).
- `new AgentClient({ …connection, attachments: { upload: mediaAttachments() } })` — your own client.
- `createMediaUpload(connection)` — a bare `upload` for `useAttachments({ upload })`, or the
  `uploadAttachment` member of your own `AgentBackend`.
- Refusals throw `MediaUploadError` with the HTTP `status` (`413`, `415`, …); an aborted or failed
  upload is discarded on the server.

Your own storage instead: `<AgentProvider attachments={{ upload: (file, { signal, onProgress }, connection) => … }}>`
(an `AttachmentUploadStrategy`), or `useAttachments({ upload })`, resolving to a
`{ mediaId, url, contentType, name }` your server's `AGENT_ATTACHMENT_STAGING` recognises.

The rest of `AgentClient` works outside `useAgentChat` too — e.g. a standalone approvals inbox:

```ts
// Human-in-the-loop, callable from any component — not just the chat screen that raised it:
await chat.approve({ toolCallId });
await chat.reject({ toolCallId, reason: 'not now' });

// The same, for a parked question set. Omitting `answers` confirms every pre-picked answer;
// `skip` proceeds on those values while recording that the user declined to choose them.
await chat.answer({ toolCallId, answers: { scope: ['file'] } });
await chat.skip({ toolCallId });
```

### What a flip-style host owns

Everything visual: bubble layout and markdown rendering, the tool-card UI (branch on
`isToolUIPart`/`isDynamicToolUIPart`), composer design, and theming/design tokens — including how
"pending approval" reads in your product. The package never renders a pixel unless you opt into
`MessageList`/`ChatInput`; what it owns is the protocol: SSE parsing, resume/reconnect, thread CRUD,
quota, and HITL routing.

### Reasoning and stop

Reasoning frames arrive as `reasoning` parts on the message (the transport maps the backend's
`reasoning` frame to the AI SDK's `reasoning-start`/`reasoning-end` chunks). `MessageItem` renders
each run behind a disclosure toggle — open while it streams, folded once the answer lands — with
`renderReasoning` and `reasoningLabel` slots to override the body and the label.

Thinking is timed and persisted: the backend reports each step's `reasoningMs` on `step-finish`, the
transport stamps it on the reasoning part, and the stored message keeps it, so a reasoning block's
`durationMs` reads the same live and after a reload. `useElapsed(running)` is the headless ticker
for while it still streams, and `formatElapsed(ms)` the label:

```tsx
function ThoughtFor({ block }: { block: TranscriptReasoningBlock }) {
  const elapsed = useElapsed(block.isStreaming);
  const ms = block.isStreaming ? elapsed : block.durationMs;
  return ms === null ? null : <span>Thought for {formatElapsed(ms)}</span>;
}
```

`ChatInput` surfaces cancel next to send:

```tsx
<ChatInput
  onSubmit={(text) => chat.sendMessage({ text })}
  isStreaming={chat.status === 'streaming'}
  onStop={() => chat.cancel()}
/>
```

### Optional markdown subpath

```tsx
import { AgentMarkdown } from '@dudousxd/nestjs-agent-react/markdown';
// <MessageList renderText={(text, { isStreaming }) => <AgentMarkdown isStreaming={isStreaming}>{text}</AgentMarkdown>} />
```

`AgentMarkdown` ships the full streamdown stack (GFM, KaTeX, syntax-highlighted code, Mermaid) — those
renderers are **optional peer dependencies**, so the base package stays light for apps that don't need them.

## License

MIT © Davide Carvalho
