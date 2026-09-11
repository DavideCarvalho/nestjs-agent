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
  const chat = useAgentChat({
    baseUrl: '/agent',
    getHeaders: () => ({ 'x-actor-id': me.id, 'x-actor-role': me.roles.join(',') }),
  });
  return (
    <>
      <MessageList
        messages={chat.messages}
        status={chat.status}
        regeneratable
        onRegenerate={() => chat.regenerate()}
      />
      <ChatInput onSubmit={(text) => chat.sendMessage({ text })} />
    </>
  );
}
```

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
  const chat = useAgentChat({ baseUrl: '/agent' });
  const transcript = useChatTranscript({
    messages: chat.messages,
    status: chat.status,
    editable: true,
    onEditSubmit: (id, text) => chat.sendMessage({ text }),
    onFork: (id) => chat.forkThread(threadId, id),
    onStop: () => chat.cancel(),
    getUsage: (message) => readUsage(message),
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
| `items[i].blocks` | `{ kind: 'text' \| 'reasoning' \| 'tools' \| 'sources' \| 'elicitation' }`. A `tools` block is a run of CONSECUTIVE tool parts — any other part between two calls (including a `step-start` marker) ends the run. A `reasoning` block carries `isOpen`/`toggle`, open while it streams. A `sources` block appears only under `sources: true`, an `elicitation` block only under `onAnswer` — see below. |
| `items[i].blocks[n]` (`tools`) | Also carries `calls`: the same parts, each with `{ toolCallId, name, isAwaitingApproval, approve, reject, error }`. |
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
// { toolCallId, preamble, questionCount, isPending, outcome, error,
//   questions: [{ id, prompt, position, multiple, selected, isPristine,
//                 options: [{ value, label, hotkey, isSelected, isDefault, select() }] }],
//   answer: { available, isSubmitting, run() }, skip: { … } }
```

Every option the agent pre-picked comes back as `isDefault` and starts `isSelected`, so confirming
is enough. `answer.run()` submits **only the questions the user touched** — the rest are omitted on
purpose, so the server applies the same defaults it showed and the settled row still records which
ones a human actually decided. A settled set keeps its block (`isPending: false`, `outcome` filled,
`selected` showing what was chosen), so one piece of markup renders both states.

Detection is structural rather than by tool name — an intake and an `ask` persist under whatever
name their row holds — and lifting is opt-in on `onAnswer` for the same reason `sources` is: with
nowhere to send an answer, a question set is still just a tool card.

**A tool call awaiting approval.** Wire `onApprove`/`onReject` and every call in a `tools` block
carries its own decision:

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

A refused settlement (403 "not your thread", a network failure) lands on `block.error` /
`call.error` with the affordance still live, rather than escaping as an unhandled rejection. Render
it — a button that silently does nothing is indistinguishable from a broken one.

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

const chat = useAgentChat({ baseUrl: '/agent', onThreadCreated: setThreadId });
// Identity-stable so the list is read once per thread, not once per keystroke.
const sources = useMemo(
  () => [createSkillsSource({ client: chat.client, getThreadId: () => threadId })],
  [chat.client],
);
```

Each item carries its provenance twice: as a `hint` the rendered row right-aligns
(`tenant:base-7 · overrides global`), and raw on `data` as `{ scope, shadows? }` for a host that
wants to draw it differently. `shadows` is present only on a clash, so "there is no org default" and
"there is one and yours wins" stay distinguishable. The list arrives ordered most-specific-scope
first, then alphabetically — that order IS the precedence, and it is passed through untouched. The
type-ahead narrows the list it received; it never re-derives which skills apply.

The shadcn `ChatComposer` wires all of this for you: pass `autocompleteSources` and it renders the
menu (`ChatCommandPalette`, grown into the combobox's listbox) above the composer card.

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
    baseUrl: '/agent',
    // Omit the key entirely when absent — `UseAgentChatOptions` is built with
    // `exactOptionalPropertyTypes`, so an explicit `threadId: undefined` doesn't type-check.
    ...(threadId !== undefined ? { threadId } : {}),
    agent: 'support',
    // Reattach to a turn still streaming when the page loaded — survives a refresh.
    resume: true,
    getHeaders: () => ({ 'x-actor-id': currentUser.id }),
    onThreadCreated: (newThreadId) => router.replace(`/chat/${newThreadId}`),
    // Fires once per run when the SERVER is done writing (title + terminal state persisted) —
    // the right signal to refetch a thread list/sidebar; `onFinish` only means "a turn rendered".
    onRunSettled: ({ status }) => {
      if (status === 'completed') refetchThreadList();
    },
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
together with the extras: `runId`/`activeRunId`, `client` (the raw `AgentClient`), thread list/CRUD
(`threads`, `loadThreads`, `loadThread`, `deleteThread`, `forkThread`, `renameThread`, `promoteThread`,
`truncateFromMessage`), `quota`/`loadQuota`, `cancel`, HITL `approve`/`reject` and `answer`/`skip`, and `regenerate`.
`MyToolCard`'s `part` prop above types as the exported `AnyToolUIPart` (`ToolUIPart | DynamicToolUIPart`
— `MessageItem` uses the same union for its own `renderToolPart` callback).

### The transport, standalone

`AgentChatTransport` is a plain AI SDK v7 `ChatTransport` — wire it straight into `useChat` for the SSE
plumbing alone, with none of `useAgentChat`'s thread/quota/approval state:

```ts
import { useChat } from '@ai-sdk/react';
import { AgentChatTransport } from '@dudousxd/nestjs-agent-react';

const transport = new AgentChatTransport({
  baseUrl: '/agent',
  getHeaders: () => ({ 'x-actor-id': currentUser.id }),
  onMeta: ({ runId, threadId }) => console.log('turn started', runId, threadId),
});
const chat = useChat({ transport });
```

### Loading persisted history

A reloaded thread's `StoredMessage[]` (from `AgentClient.getThread`) needs converting to `UIMessage[]`
before it can seed `useChat`'s `initialMessages`:

```ts
import { storedThreadToUiMessages } from '@dudousxd/nestjs-agent-react';

const detail = await chat.client.getThread(threadId);
const initialMessages = storedThreadToUiMessages(detail.messages);
// Feed into useAgentChat({ threadId, initialMessages, ... }) on the mount that owns this thread —
// `initialMessages` is only read once, on mount.
```

`storedThreadToUiMessages` merges the store's one-row-per-model-iteration turns (a turn with tool
calls persists as "thinking…" + tool calls, then a separate final-answer row) into ONE `UIMessage` per
conversational turn, matching how the live stream renders — and stamps `metadata.usage` on any turn it
merged. For a single already-atomic row, `storedMessageToUiMessage` maps it 1:1 with no merging.

### Attachments and the raw client

`uploadAttachment` and the rest of `AgentClient` work outside `useAgentChat` too — e.g. from a
file-picker or a standalone approvals-inbox screen:

```ts
const attachment = await chat.client.uploadAttachment(file); // → MessageAttachment
await chat.sendMessage({ text: 'what is in this?' }, { body: { attachments: [attachment] } });

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
