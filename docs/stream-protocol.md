# The chat stream protocol

What `POST <base>/chat` and `GET <base>/chat/:runId/stream` put on the wire, precisely enough that a
backend which does **not** run this library's agent loop (a sandboxed runner, a different framework,
a proxy in front of another agent) can serve it and get `@dudousxd/nestjs-agent-react` — the
transport, `useAgentChat`, the transcript model — unchanged.

The TypeScript source of truth is `AgentStreamEvent` in
[`packages/core/src/stream-events.ts`](../packages/core/src/stream-events.ts). This page is the
contract around it.

## Framing

The response is `Content-Type: text/event-stream`. Optional response headers `X-Agent-Run-Id` and
`X-Agent-Thread-Id` let a client learn the run before the first frame.

Frames are separated by a blank line (`\n\n`). Four shapes:

| Frame | Meaning |
|---|---|
| `event: meta` + `data: {"runId": string, "threadId": string}` | Identity of the run. Send it first. A client binds approve/reject/cancel to `runId` and a threadless chat adopts `threadId`. |
| `data: <AgentStreamEvent JSON>` (no `event:` line) | One stream event, one JSON object per frame. |
| `event: done` + `data: {}` | The run ended normally (including a cancel — see `cancelled`). |
| `event: error` + `data: {"code": string, "message": string}` | The run failed. `message` is shown to the user. Codes this library uses: `quota_exceeded`, `output_rejected`, `structured_output_invalid`, `run_failed`. |

Multi-line `data:` is joined with `\n`.

`GET <base>/chat/:runId/stream` replays the run's buffered frames from the beginning and then tails
it. Answer `404` when nothing is streaming under that id — the client reads that as "nothing to
resume", not an error.

### Sequence numbers and reconnecting

Number every event frame with an SSE `id:` line — a positive safe integer, strictly increasing
within the run:

```text
id: 7
data: {"kind":"text","text":"…"}
```

- The number is a property of the frame, not of the connection: the same frame carries the same id
  on the `POST` that started the run and on every later `GET …/stream`. (This library numbers the
  frames by their 1-based position in the run's buffered stream, which every sink replays from its
  first chunk in write order.)
- Ids may skip numbers. Only the order matters: a client keeps the highest id it took in as its
  cursor and drops anything at or below it.
- `meta`, `done` and `error` carry no id. Send `meta` again on every attach.
- `GET <base>/chat/:runId/stream?after=<n>` sends only the frames numbered above `n` (still preceded
  by `meta`). Honour the standard `Last-Event-ID` request header the same way; `after` wins when
  both are present.

The client uses this to survive a dropped connection: when a numbered stream errors or closes
without `done`, it re-attaches with `?after=<last id it saw>` (exponential backoff; `status:
'reconnecting'` meanwhile) and continues the same message. It also drops any frame numbered at or
below its cursor, so a server that ignores `after` still resumes correctly, only less cheaply.
A `404` on that re-attach means the run ended while the client was away; `useAgentChat` then
reloads the thread. A stream **without** ids is never resumed: one that closes without `done` is
treated as finished, as before.

#### Numbering a stream you rebuild

A runner that is not this library's loop often cannot replay a run frame for frame after its
process restarts: the live deltas are gone, and it rebuilds what already streamed from its own
durable state (checkpoints, stored steps), condensed into fewer, larger frames. A counter restarted
at `1` would then give the same id to different frames, and a client resuming with
`?after=<n>` would skip frames it never saw, or take in again what it already has. So derive ids
from durable facts, never from a per-process counter:

1. **Ids live in the run's own time, not the process's.** Number each frame from something that
   survives a restart and only moves forward — for example milliseconds since the run started (the
   start instant stored with the run), taking `max(previous + 1, elapsed)` so ids stay strictly
   increasing. Frames written after a restart then number above anything written before it.
2. **Give every frame of one source event its own slot.** When one event becomes several frames,
   number them `event × K + index` (with `K` above the most frames one event can produce), so every
   attach numbers them alike.
3. **Rebuilt frames reuse the range of what they replace.** Store with each checkpoint the last id
   it covered. A rebuilt step's condensed frames take ids inside that step's range (from just
   after the previous checkpoint's last id), so a client that saw the step skips them all and a
   client that did not takes them all in.
4. **Never reuse an id for different content, never go backwards.**

Put a rebuilt step's condensed frames at the start of its range and the frame it parked on (an
approval, a question) at the end, where the live stream raised it; that request's settlement takes
the first id after the range. The one case numbering cannot fix is a client that saw only part of a
step that was then condensed: it keeps what it had and skips the condensed rest, and the stored
answer (a reload of the thread) is complete. Checkpoint at every pause to keep that window small.

`meta` still comes first on every attach, and `?after=` / `Last-Event-ID` work the same way. This
library's own runner needs none of this: its sink keeps the run's frames, so a replay is the
original stream.

## Event rules

1. Every event is a JSON object with a string `kind`.
2. A reader MUST tolerate a `kind` it does not know. The React transport forwards it as a
   `data-<kind>` part (below) — it never drops it and never fails the stream.
3. Fields are only ever added, and added fields are optional. Absent optional fields are omitted,
   not `null`.
4. Tool calls are addressed by `id`, unique within the run. Every frame about a call (`tool-input-*`,
   `tool-output*`, `approval-requested`, `approval-settled`, `elicitation`) uses the same `id`, and the call MUST be
   announced (`tool-input-start` or `tool-input-available`) before its outcome or approval frame —
   the AI SDK drops the whole message when a call is settled before it exists. The React transport
   guards the approval case, but not the outcome case.
5. A run is ONE assistant message. `step-start`/`step-finish` bracket one model call plus its tool
   execution; text and reasoning are grouped per step. A runner with no notion of steps may send a
   single `step-start` at the beginning and a `step-finish` at the end, or none at all (the client
   opens a step on the first content frame and closes it at `done`).

## Events

| `kind` | Fields | Client effect (AI SDK v7 chunk) |
|---|---|---|
| `step-start` | — | `start-step` |
| `step-finish` | `usage?: { inputTokens, outputTokens, … }`, `costUsd?: number \| null`, `reasoningMs?: number` | closes open text/reasoning, `finish-step`; `costUsd` → `message-metadata` `{ costUsd }` (`null` = unpriced, never a fabricated `0`); `reasoningMs` → the closing reasoning part's `providerMetadata.agent.reasoningMs` (without it the client stamps the time it watched the reasoning stream, which reads ~0 on a replay — send it) |
| `text` | `text: string` (a delta) | `text-start` once per run of prose, then `text-delta` |
| `reasoning` | `text: string` (a delta) | `reasoning-start` once, then `reasoning-delta` |
| `tool-input-start` | `id`, `name`, `toolKind: 'read' \| 'action'`, `parentId?` | `tool-input-start` with `toolMetadata: { toolKind, parentId? }` |
| `tool-input-delta` | `id`, `delta: string` (a JSON text fragment of the input) | `tool-input-delta` |
| `tool-input-available` | `id`, `name`, `input`, `toolKind`, `parentId?` | `tool-input-available` (metadata merged with what `tool-input-start` said) |
| `tool-output` | `id`, `output` | `tool-output-available` |
| `tool-output-error` | `id`, `error: string` | `tool-output-error` — the call failed, effects unknown |
| `tool-output-denied` | `id`, `reason?` | `tool-output-denied` — a person said no; nothing ran |
| `elicitation` | `id`, `request: { preamble?, questions[] }` | opens an `ask` tool call carrying the questions (see *Asking the user*) |
| `approval-requested` | `id`, `approver: string`, `expiresAt?: string`, `reason?: string` | `data-approval-requested` part (id = call id) + native `tool-approval-request` (`approvalId` = call id); the tool part moves to `state: 'approval-requested'` |
| `approval-settled` | `id`, `status: 'approved' \| 'rejected' \| 'expired'`, `approver?`, `decidedBy?`, `decidedVia?`, `remember?: boolean`, `reason?` | `data-approval-settled` part (id = call id); folded into the call's `approval` by the transcript. The call's own state still moves on its output frame |
| `ui` | `id`, `component: string`, `props: object`, `version?: number`, `toolCallId?: string` | `data-ui` part (id = component id, data carries `toolCallId`); a repeat `id` replaces the component in place. Closes the open prose so later text renders after it |
| `title` | `title: string` | transient `data-title` (not stored on the message); `useAgentChat({ onTitle })` |
| `message-metadata` | `metadata: object` | `message-metadata` — merged into the message's `metadata`. Host-defined facts (the model that answered, the turn's duration, the error it ended with); persist the same values as `StoredMessage.metadata`. This library's loop never sends it |
| `cancelled` | — | transient `data-cancelled`. Send it as the last frame before `done` when someone stopped the run, so a reader can tell a truncated answer from a complete one |
| `queue` | `queue: { items: QueuedMessageView[], paused: QueuePause \| null }`, `started?: { messageId, runId }` | transient `data-queue`. A snapshot of the thread's message queue (see *Message queue*): sent when it changes while this run holds the thread, and — with `started` — just before this run's terminal when the thread passes to the next queued message. `useAgentChat` keeps `chat.queue` from it and attaches to `started.runId` |
| *anything else* | any | `data-<kind>` part carrying the frame minus `kind`, keyed by `id` when the frame has a string `id` |

### Tool kinds and approvals

`toolKind: 'action'` marks a call that waits for a person before it executes. A client treats an
`action` call whose input is available and whose outcome has not arrived as awaiting approval, with
or without `approval-requested`. The frame adds who may decide and until when:

- `approver` is an open vocabulary the host defines — `'requester'` (the person chatting), `'admin'`,
  a role or team name. A client uses it to show "waiting on an admin" instead of buttons the viewer
  cannot use.
- `expiresAt` is ISO-8601. Absent → the request does not lapse.
- A client that checked `part.state === 'input-available'` to find pending calls must also accept
  `'approval-requested'` once a runner sends this frame; `TranscriptToolCall.isAwaitingApproval`
  already covers both.
- The decision is sent with `POST <base>/tool-call/approve` `{ toolCallId, remember?, via? }` /
  `POST <base>/tool-call/reject` `{ toolCallId, reason?, via? }`. The approval id IS the tool call
  id. `remember: true` approves later calls of the same tool in the same thread without asking;
  `via` names the surface the decision came through (the lib records `'web'` when omitted). A
  server answers `403` to a caller who is not the approver and `410` once the request lapsed.

The stream stays open while the run waits (a client that dropped reconnects through
`GET <base>/chat/:runId/stream`). After the decision, continue on that stream with
`approval-settled` (optional, recommended) and the outcome: `tool-output` when it ran,
`tool-output-denied` when it was declined or lapsed, `tool-output-error` when it failed.

### How an approval settles

`approval-settled` says who decided and how; it never carries the outcome itself.

| `status` | Send it when | Then |
|---|---|---|
| `approved` | a person approved (`decidedBy`, `decidedVia`, `remember`), or a remembered approval covered the call (`decidedVia: 'remembered'`, `remember: true`, plus `approver` since no request was streamed) | `tool-output` or `tool-output-error` |
| `rejected` | a person declined (`decidedBy`, `decidedVia`, `reason`) | `tool-output-denied` with the same `reason` |
| `expired` | `expiresAt` passed with nobody deciding | `tool-output-denied` with `reason: "approval expired"` |

The transcript model reads both approval frames into `TranscriptToolCall.approval`:
`{ approver, expiresAt, reason, status, remember, decidedBy, decidedVia, decisionReason }`. `status`
is `pending` until a settlement arrives; a runner that never sends one still gets `rejected` /
`approved` from the call's own state. `useApprovalCountdown(call.approval?.expiresAt)` gives the
time left, ticking, for a headless countdown.

In this library the approver, the time to live and the "no approval needed" answer come from the
`ApprovalPolicy` SPI (`AgentModule.forRoot({ approvalPolicy })`); a role approver is enforced on the
approve/reject routes by the policy's `canDecide` (default: the decider holds that role). An expiry
is settled by the runner itself — the durable runner hands the time to live to the signal wait's
own timeout — and the model is told the approval expired, not that someone said no.

**A runner that is not this library's loop** (e.g. one translating another agent's permission
prompts) maps its own approval model onto these frames: its "who may decide" onto `approver`, its
deadline onto `expiresAt`, its outcome record (who, which channel, "always allow") onto
`approval-settled`. It enforces approvers and expiry on its own approve/reject routes, since those
are the only way a decision reaches it.

### Asking the user

`elicitation` parks the run on a question set; it is answered with
`POST <base>/tool-call/answer { toolCallId, answers?: Record<questionId, string[]>, via? }` (an
omitted question takes its `defaults`) or declined with
`POST <base>/tool-call/skip { toolCallId, via? }`. `via` names the surface the answer came through,
as on approve/reject (`'web'` when omitted). The matching `tool-output` carries the settled outcome:

```ts
{
  answers: Record<questionId, string[]>;  // every question, defaults filled in
  skipped: boolean;
  defaulted: string[];                    // questions filled from their defaults
  summary?: string;                       // the answers as the model read them
  answeredBy?: string;                    // who answered or skipped — an approval's decidedBy
  answeredVia?: string;                   // through which surface — an approval's decidedVia
}
```

Persist the same object as the call's stored result, so a reload shows who answered too. The
transcript reads it into `TranscriptElicitationBlock.outcome` (`answeredBy` / `answeredVia`, `null`
when absent). In this library `answeredBy` is the answering actor's id; a host that serves these
routes itself may send a display name.

A question is either a pick from `options` or a typed value:

```ts
{
  id: string;
  prompt: string;
  description?: string;                   // help under the prompt
  options?: { value, label, hotkey? }[];  // required unless `input` asks for a typed value
  multiple?: boolean;
  defaults?: string[];                    // pre-picked; required for a pick, optional when typed
  allowFreeText?: boolean;
  input?: {
    type: 'text' | 'textarea' | 'number' | 'boolean' | 'date' | 'email' | 'url' | 'select';
    placeholder?: string;
    required?: boolean;
    min?: number | string;                // number: min · text: min length · date: earliest YYYY-MM-DD
    max?: number | string;
    pattern?: string;                     // regex the whole value must match
  };
}
```

Answers stay `string[]` whatever the type, in one canonical form: numbers as decimals (`"42"`),
booleans as `"true"`/`"false"`, dates as `YYYY-MM-DD`, everything else as typed. The answer route
answers `400` (`answers["<id>"] <reason>`) for a value a question's rules refuse or a `required`
question left without an answer or default. React's `coerceAnswer`/`validateAnswer` apply the same
rules client-side.

**Mapping another runner's forms.** A runner that is not this library's loop emits its own form
prompts as an `elicitation` frame and converts the answers back. For example, an OpenCode `question`
tool field `{ key, type, title, description, required, options }` maps as:

| OpenCode field | `ElicitationQuestion` |
|---|---|
| `key` | `id` |
| `title` (fall back to `key`) | `prompt` |
| `description` | `description` |
| `options: [{ value, label }]` | `options` (plus `input: { type: 'select' }`, and `defaults` when there is a sensible pick) |
| `type: 'string'` | `input: { type: 'text' }` — or `textarea` / `email` / `url` / `date` when the runner knows more |
| `type: 'number' \| 'integer'` | `input: { type: 'number' }` (plus `min`/`max` when the runner has bounds) |
| `type: 'boolean'` | `input: { type: 'boolean' }` |
| `required: true` | `input.required: true` |

and each answer back with the inverse of the canonical form — `Number(v[0])`, `v[0] === 'true'`,
the string itself — before handing it to the runner that asked. Enforce the same rules on its own
answer route: the transcript model reports them, but only the server can refuse them.

### Nested calls

`parentId` places a call under another call on the same stream — the inner calls of a code-mode
`execute`, the tools of a delegated agent. Rules:

- the parent is announced first;
- the first frame that names a parent fixes it; later frames may omit `parentId`;
- a `parentId` naming a call the client does not have (or forming a cycle) is shown top-level — it
  is never an error.

A stored `toolCalls[]` entry carries the same `parentId`, so a reloaded thread nests the call too.

The transcript model exposes this as `TranscriptToolBlock.roots` / `TranscriptToolCall.children`.
Keep inner-call frames adjacent to their parent (no prose between them) so they land in the same
tool block.

### Generative UI

`ui` is for components the server decides to show that are not a tool call's rendering. `component`
is a key into the client's own registry (the library ships none); `props` must be JSON. Use
`version` when `props` changes shape, so a client can still render components an older server
persisted. Emitting the same `id` again (e.g. streaming rows into a table) updates it; it never
duplicates it.

`toolCallId` names the tool call that pushed the component, when one did. Send it between that
call's announcement and its outcome frame; a reloaded message places the component right after the
call's tool part, which is where the live stream showed it.

**In this library** a tool pushes with `ctx.emitUi(component, props, { id?, version? })`. The frame
streams immediately (inline, durable in-process, and from the worker serving a dispatched tool step),
`id` defaults to `<toolCallId>:ui:<n>`, and the components ride the tool step's journaled result, so
a durable replay neither re-streams nor re-persists them. Once the step's tools have settled, the
loop persists every component of the step on the assistant message (`AgentStore.setMessageUi`): the
model turn's own frames first, then the tools' pushes in call order.

**A runner that is not this library's loop** (a sandboxed agent, an OpenCode runner) does the same
with its own tools:

1. write a `ui` frame with a stable `id` — derive it from the call (`<callId>:ui:<n>`) so a retried
   or replayed call replaces what it pushed instead of adding a copy — and `toolCallId`;
2. write it after the call is announced and before its outcome;
3. persist it in the assistant message's `ui` list (first-seen order, last props per `id`, the
   `toolCallId` kept) so `GET <base>/threads/:id` returns what the stream showed;
4. if the runner replays work, make the persisted list a function of the replayed results (replace
   the list, never append), so a replay writes the same value.

Two conventions from `@dudousxd/nestjs-agent-core/genui` (a catalog is optional — the frame is the
contract):

- a **composed tree** travels as ONE frame, `component: "genui:tree"`, `props: { root }`, where each
  node is `{ type, props, children? }` and `type` is a registry key (json-render's nested shape). A
  client renders it node by node through the same registry, or converts it to a json-render flat
  spec;
- component names are letters and digits (`DataTable`), so `genui:tree` can never collide with one.

## Tool catalog

`GET <base>/tools?agent=<name>` returns `{ name, kind, presentation? }[]` for the tools the caller can
reach — what `useToolCatalog` reads to narrate calls by the tool's declared words instead of its
name. `presentation` is `{ label, running, done, icon?, detail?, tone?, confirm?: { title, verb,
detail? }, result? }` (`running`/`done`/`confirm` are `{dotted.path}` templates over the call's input;
`result` is a view over its output — see `ToolPresentation` in `packages/core/src/tool-presentation.ts`).
`?agent=*` answers the union across every agent — each tool the caller reaches through any of them,
once — for a surface that shows several agents' conversations (`useToolCatalog({ agent:
ALL_AGENTS })`). A runner that serves these routes can answer it from its own tool list; a tool with no entry is
narrated generically.

## Persisted history

`GET <base>/threads/:id` returns `StoredMessage`s, which the client turns back into the same parts
(`storedThreadToUiMessages`). Besides `content`, `toolCalls`/`toolResults` and `attachments`, a
message may carry, per step:

| Field | Replayed as |
|---|---|
| `reasoning?: string` | a `reasoning` part, placed before the text |
| `reasoningMs?: number` | that part's `providerMetadata.agent.reasoningMs` (the transcript's `durationMs`) |
| `ui?: { id, component, props, version?, toolCallId? }[]` | `data-ui` parts, first-seen order, last props per `id`; one with a `toolCallId` goes right after that call's tool part |
| `approvals?: { toolCallId, approver, expiresAt?, status, remember?, decidedBy?, decidedVia?, reason? }[]` | a `data-approval-requested` part per entry, plus a `data-approval-settled` part once `status` is not `pending` — the same parts the live frames become |
| `metadata?: object` | spread into `message.metadata` under the library's own keys (`usage`, `feedback`, `createdAt` win) — what `message-metadata` frames streamed |
| `feedback?: { value: 'up' \| 'down', comment?, updatedAt }` | `message.metadata.feedback` (on a merged turn, the last row's) — what `useMessageFeedback` shows |

A runner serving these routes should persist the same values it streamed, so a reload shows what
the live stream did.

## Message queue

A person can keep typing while a turn is running. A message sent then is **queued on the thread,
server-side** — it survives a reload, a closed tab, another device — and runs as soon as the turn
ahead of it settles, exactly as if it had been sent then. Nothing about a queued message is in the
transcript until it runs: the turn it starts appends it as its user message.

### Sending

`POST <base>/chat` takes `mode`:

| `mode` | Thread idle | Thread busy (a turn is running) |
|---|---|---|
| `'auto'` (default) | starts the turn, streams it | queues it at the tail → `202` |
| `'queue'` | queues it, and starts it at once → `202` with `runId` | queues it at the tail → `202` |
| `'interrupt'` (or `interrupt: true`) | starts the turn, streams it | queues it at the **head**, cancels the running turn → `202` with `interrupting` |

`'queue'` always answers `202`, so a client that asked for a queued send handles one shape. The
`202` body:

```json
{
  "queued": true,
  "threadId": "thr_1",
  "messageId": "q_7",
  "position": 0,
  "queue": { "items": [{ "id": "q_7", "content": "and in EUR?", "createdAt": "…", "updatedAt": "…" }], "paused": null },
  "runId": "q_7",
  "interrupting": "run_1"
}
```

`position` is 0-based (`0` → runs next). `runId` is present only when the message started straight
away; `interrupting` only for an interrupt. **A queued message's run id is its own `messageId`** —
a client can name the run before it starts.

Everything a send carries (`agent`, `model`, `attachments`, `pageContext`) is resolved and checked
when it is queued (`400`/`403`/`429` then, not later), and stored with the message; the actor is the
one who queued it. `regenerate` is refused with `409 { code: 'run_active' }` while a turn runs — it
rewinds the thread under the running turn.

A `QueuedMessageView` is `{ id, content, attachments?: MessageAttachment[], agentName?, model?,
interrupt?: true, createdAt, updatedAt }`. A `QueuePause` is `{ reason: 'run_failed' | 'cancelled' |
'quota_exceeded' | 'start_failed', message?, at }`.

### Draining

When the turn holding the thread settles, the server — **before** writing that turn's terminal
frame — decides what follows and moves the thread there:

| The turn… | The queue |
|---|---|
| completed | the head starts |
| failed | pauses (`run_failed`, `message` = the failure) — the next message would likely fail the same way, and the person should see the error before more of their messages are spent |
| was cancelled (Stop) | pauses (`cancelled`) — Stop means stop. A Stop that lands after the turn's last model call already answered still pauses |
| was cancelled by an interrupt | the interrupt's message (the head) starts |

The head's actor is checked against the quota as it starts; an exhausted budget pauses the queue
(`quota_exceeded`) instead of starting it. A paused queue keeps every message and starts nothing
until `POST <base>/threads/:id/queue/resume` (which starts the head when nothing is running). A
plain send on an idle thread still runs at once while the queue is paused — the pause holds the
queue, not the thread.

The decision is announced in the settling turn's stream as its last frame before the terminal:

```text
data: {"kind":"queue","queue":{"items":[],"paused":null},"started":{"messageId":"q_7","runId":"q_7"}}

event: done
data: {}
```

A client that sees `started` shows the queued message as a user message and attaches to the new
run with `GET <base>/chat/q_7/stream` (a `404` there means it already finished — re-read the
thread). Without `started`, `queue.paused` says why nothing runs. Every change to the queue while a
turn holds the thread (a message queued, edited, moved, removed) is also written into that turn's
stream as a `queue` frame, so every tab watching the thread stays in step. Each frame is a whole
snapshot, never a delta: a client that missed one is corrected by the next.

### Admission — one turn per thread

The queue only works if exactly one turn holds a thread at a time, across processes. The thread's
active run (the `activeRunId` a thread read reports) is the admission lock, and every write to it is
a **compare-and-set**:

- *claim* — set it to a run id only when it is empty, already that id, or held by the run that is
  handing over. Of two racing claims exactly one wins; the loser queues.
- *release* — clear it only when the settling run still holds it, so a run that handed the thread on
  can never clear its successor.

A drain claims the thread **for the head's id** (handing over from the settling run), deletes the
head (a conditional delete — if it is already gone, the claim is given back and the next head is
tried), then starts the run under that id. Because the run id is the message id, a retried drain is
idempotent: the claim succeeds again for the same id, and a start under an id that already exists is
a no-op. After releasing an empty queue the drain reads it once more, and a send that queues behind
a busy thread tries to start the head after enqueueing — so a message queued in the instant between
a drain's read and its release is never stranded. A holder that is no longer running (a process
that crashed mid-turn) is replaced by the next send or resume rather than queued behind for ever;
a server that cannot tell whether a holder is alive must assume it is.

### For a backend that is not this library

To serve the queue to the React client (`chat.queue`, `whileRunning`), a backend implements:

1. `POST <base>/chat` with `mode` as above, answering `202` + the body above when it queues.
2. Per-thread FIFO storage of queued messages, surviving restarts: text, resolved attachments,
   agent, model, page context, the actor, an `interrupt` flag, an order.
3. A per-thread pause (`QueuePause | null`).
4. The drain on every settle of a thread's own turn (not a sub-agent's), before the terminal frame,
   with the policy table above, using compare-and-set admission.
5. The `queue` frame — on every change while a turn holds the thread, and with `started` on a
   handoff.
6. The five queue routes (`GET`/`DELETE threads/:id/queue`, `POST threads/:id/queue/resume`,
   `PATCH`/`DELETE queue/:messageId`), ownership-gated like the thread routes.
7. `queue` on `GET <base>/threads/:id`.

A backend that serves none of it keeps working: the client's `whileRunning` falls back to `'block'`
when the backend has no `enqueueMessage`, and a server that answers every send with a stream is a
server that never queues. A backend that runs its own agent process (a sandboxed runner) can hold
the queue in its own storage and drive the drain from wherever it learns the turn ended — the
contract is the wire, not this library's classes. This library's stores implement it through
`ChatQueueStore` (core), checked by `CHAT_QUEUE_STORE_CONTRACT` (`@dudousxd/nestjs-agent-testing`),
which a store of your own can run too.

## The REST surface

Everything `AgentClient` (the default `AgentBackend` of `@dudousxd/nestjs-agent-react`) calls, so a
backend that is not this library can serve the same routes and keep the React layer unchanged.
`<base>` is wherever you mount them (`/agent` in this library).

**Errors.** A refused request answers its HTTP status with a JSON body `{ message, code? }` —
`message` in words a person can read (NestJS's validation list of messages is accepted too), `code`
a machine-readable reason (`quota_exceeded`, `model_not_allowed`, …). The client throws
`AgentHttpError` (`MediaUploadError` for `mediaAttachments()` uploads) carrying `status`, `code`,
the parsed `body`, and the server's `message` as its own `message` — so every hook that shows
`error.message` (a failed send in `chat.error`, a refused upload on the staged file, a refused
approve/answer on the card) shows the server's words. `<AgentProvider onHttpError>` (or
`new AgentClient({ onHttpError })`) sees every error answer before it is thrown, for app-wide
reactions such as "401 → sign in again"; a resume's `404` is not an error and is not reported.

| Route | Body / query | Answers |
|---|---|---|
| `POST <base>/chat` | `{ message, threadId?, agent?, model?, attachments?: { mediaId }[], pageContext?, regenerate?: true, transient?, mode?: 'auto' \| 'queue' \| 'interrupt' }` | the SSE stream above — or `202 { queued: true, … }` JSON when the message waits in the thread's queue (see *Message queue*); `400` for a `model` the catalog does not offer as available. `model` is that turn's only (see *Models*); `regenerate` see *Regenerating an answer* (`409 run_active` while a turn runs) |
| `GET <base>/chat/:runId/stream` | `?after=<seq>` or `Last-Event-ID` | the SSE stream, from after the cursor; `404` when nothing streams under that id |
| `POST <base>/chat/:runId/cancel` | — | `{ aborted: boolean }` |
| `GET <base>/threads` | — | `ThreadSummary[]` (`{ id, title, transient, createdAt, updatedAt, lastMessagePreview?, defaultAgent?, activeRunId?, model? }`) |
| `GET <base>/threads/:id` | — | `ThreadDetail` (a summary plus `messages: StoredMessage[]`, and `queue?: ChatQueueState` when the server queues); `activeRunId` is the run streaming right now, the one to resume |
| `PATCH <base>/threads/:id` | `{ title?, defaultAgent?: string \| null, model?: string \| null }` | `{ ok: true }`; `model` pins a catalog model on the thread (`null` unpins) |
| `DELETE <base>/threads/:id` | — | `{ ok: true }` |
| `POST <base>/threads/:id/fork-from/:messageId` | — | `ThreadSummary` of the fork |
| `POST <base>/threads/:id/promote` | — | `{ ok: true }` |
| `DELETE <base>/threads/:id/from/:messageId` | — | `{ ok: true }` |
| `GET <base>/threads/:id/queue` | — | `ChatQueueState` — `{ items: QueuedMessageView[], paused: QueuePause \| null }` |
| `DELETE <base>/threads/:id/queue` | — | `ChatQueueState` (empty); also lifts a pause |
| `POST <base>/threads/:id/queue/resume` | — | `ChatQueueState & { runId? }` — lifts a pause; `runId` when the head started |
| `PATCH <base>/queue/:messageId` | `{ message?, attachments?: { mediaId }[] \| null, position?: number }` | `ChatQueueState`; `410` when the message already started or was removed |
| `DELETE <base>/queue/:messageId` | — | `ChatQueueState`; `410` when already gone, `404` unknown, `403` another actor's |
| `POST <base>/messages/:id/feedback` | `{ value: 'up' \| 'down' \| null, comment? }` | `{ feedback: { value, comment?, updatedAt } \| null }` — `null` clears; `403` for another actor's message, `404` unknown, `400` a bad value |
| `POST <base>/tool-call/approve` / `reject` / `answer` / `skip` | see *Tool kinds and approvals* and *Asking the user* | `2xx` |
| `POST <base>/attachments` | multipart, field `file` | `MessageAttachment` (`{ mediaId, url, contentType, name }`); `413` too large, `415` a type it refuses |
| `GET <base>/tools?agent=` | — | see *Tool catalog* |
| `GET <base>/skills?threadId=` | — | `SkillCatalogEntry[]` |
| `GET <base>/models?agent=` | — | `{ providers: [{ id, label, models: [{ id, label, description?, badges?: string[], available, unavailableReason?, contextWindow? }] }], default: string \| null, locked?: { model, reason? } }` |
| `GET <base>/agents` | — | `{ name, description, isDefault?, lockedModel? }[]` |
| `GET <base>/quota` | — | `{ windows: [{ period: 'day' \| 'month', usedTokens?, limitTokens?, usedUsd, limitUsd?, resetsAt?, warnAt? }], blocked?: { period, reason? }, warning?: { period, ratio, reason? } }` |
| `GET <base>/config` | — | `{ attachments: { enabled, upload: 'multipart' \| 'resumable' \| null, maxBytes, allowedContentTypes, maxPerMessage }, models: { enabled }, quota: { enforced }, identity: { anonymous } }` — server facts a client would otherwise repeat; `useAttachments` takes its defaults from it |

**Models.** A turn's model is the send's `model`, else the thread's pinned `model`, else the
server's default. A send's `model` applies to **that turn only**: the server never stores it on the
thread, whether the send creates the thread or continues one. Pinning is its own, explicit
request — `PATCH <base>/threads/:id { model }` (`null` unpins) — and only a pin outlives the turn.
Serve the catalog from whatever decides what a caller may use (plan, budget, provider health) and
refuse anything else with `400` — the client only ever sends ids the catalog listed, but a server
must not trust that. `chat.models` renders the catalog; `select(id)` makes this chat's following
sends name that model (dropped when the chat switches threads); `chat.models.pinToThread(id)` pins
it, replacing the pick; `chat.models.pinned` is the thread's pin.

An agent **locked** to one model answers `locked: { model, reason? }` on `GET <base>/models` (and
`lockedModel` on its `GET <base>/agents` entry). Every turn then runs on `locked.model`, whatever
the send or the thread's pin names; a send naming another model is refused with `400`. List the
other models as unavailable as well, so a client that predates the field cannot pick them.
`useModels().locked` / `chat.models.locked` expose it; while locked, `select` does nothing and
`selected` is the locked model. In this library the lock comes from your `ModelCatalog`.

**Regenerating an answer.** `POST <base>/chat { threadId, regenerate: true }` answers the thread's
last user message again — the retry button under the last answer (`chat.regenerate()`, the
transcript's `item.regenerate.run()`). The server:

1. requires `threadId` (`400` without one) and the caller's own thread;
2. does **not** store a user message — `message` in the body is ignored, the stored one is
   answered;
3. drops the answer(s) after that user message (the replaced turn's rows, and whatever the runner
   keeps of it — a sandboxed agent's own session history included), so the model does not see the
   answer it is replacing;
4. streams the new answer as a normal run, under a new `runId`.

`model`, `agent` and `pageContext` apply as on any send. The client removes the old answer from the
screen before the new one streams, so a reload shows the same single user message and one answer.

**Attachments.** The client uploads each file on its own — `POST <base>/attachments` (multipart
`file`), or the resumable `<base>/attachments/uploads` routes when `GET <base>/config` says
`upload: 'resumable'` — then names the uploads by id on the send: `POST <base>/chat { message,
attachments: [{ mediaId }] }`. That is the one shape: an entry carrying anything besides `mediaId` is
refused with `400`, and only the id is trusted — the server resolves the url the model fetches from
its own storage. `GET <base>/threads/:id` returns them on the user message as `attachments: [{
mediaId, url, contentType, name }]`, the `url` re-minted by `mediaId` on every read (so an old turn's
presigned link has not expired), replayed as `file` parts carrying
`providerMetadata.agent.mediaId`. `useAttachments` stages, validates and uploads; `messageFiles`
reads them back off a message.

**Quota.** `GET <base>/quota` reports every budget window the server enforces; `blocked` names the
exhausted one. A server that enforces it answers `POST <base>/chat` with `429` and
`{ code: 'quota_exceeded', period, message }` while blocked. `useQuota` renders the windows and
`useAgentChat` stops the client from sending in the meantime. A backend with its own
budget (an AI-gateway spend cap) reports it here in the same shape.

- A window reports the units its budget counts: a USD-only budget leaves `usedTokens` (and
  `limitTokens`) out rather than sending `0`; a token-only one still sends `usedUsd`.
- `warnAt` (`0..1`) is the window's soft limit: past that share of a ceiling a client should warn.
  The report's `warning: { period, ratio, reason? }` names the fullest window past its `warnAt`
  (never while `blocked`). `useQuota().warning` / `chat.quota.warning` expose it — the server's,
  else derived from the windows (`quotaWarning` in core). In this library,
  `AgentModule.forRoot({ quota: { limits, warnAt: 0.8 } })` sets it on the ledger's windows.

**Identity.** Every route acts as the actor the server resolves from the request; nothing in the
body names one. With no resolver configured this library serves the routes publicly and gives each
browser its own anonymous actor: on the first request without it, the response sets
`agent_anon=<32 random bytes, base64url>; Path=/; Max-Age=31536000; HttpOnly; SameSite=Lax` (plus
`Secure` over HTTPS), and the actor id is `anon:` + a SHA-256 digest of the token. Threads, quota and
attachments belong to that id. A client needs no code for it — the browser carries the cookie — but
a cross-site client must send `credentials: 'include'` (and the server set `SameSite=None`). A
backend with real auth ignores all of this and answers `401` to an unauthenticated request.

**Cookie sessions and CSRF.** Nothing here assumes bearer tokens. A backend on a cookie session
answers these routes like any other same-site request and checks its CSRF header on the mutating
ones (every `POST`/`PATCH`/`DELETE` above, including `POST <base>/chat`). The React client sends the
header through `getHeaders`, read per request (e.g. `X-XSRF-TOKEN` from the `XSRF-TOKEN` cookie),
with `credentials: 'include'` when the API is on another origin — or implement `AgentBackend` over
your own client and apply whatever your app already does.

## Example

`id:` lines are left out for brevity — a server that numbers its frames puts `id: 1`, `id: 2`, …
above each `data:` frame (not above `meta`/`done`).

```text
event: meta
data: {"runId":"run_1","threadId":"thr_1"}

data: {"kind":"title","title":"Refund for order 1042"}

data: {"kind":"step-start"}

data: {"kind":"text","text":"Let me look that order up."}

data: {"kind":"tool-input-start","id":"c1","name":"execute","toolKind":"read"}

data: {"kind":"tool-input-available","id":"c1","name":"execute","input":{"code":"…"},"toolKind":"read"}

data: {"kind":"tool-input-available","id":"c1.0","name":"orders.get","input":{"id":1042},"toolKind":"read","parentId":"c1"}

data: {"kind":"tool-output","id":"c1.0","output":{"status":"paid"}}

data: {"kind":"tool-output","id":"c1","output":{"ok":true}}

data: {"kind":"ui","id":"u1","component":"order-card","props":{"id":1042,"status":"paid"},"version":1}

data: {"kind":"tool-input-available","id":"c2","name":"refund","input":{"id":1042},"toolKind":"action"}

data: {"kind":"approval-requested","id":"c2","approver":"admin","expiresAt":"2026-10-01T12:00:00.000Z","reason":"Refunds need an admin"}

    … the stream stays open while the run waits; an admin POSTs /tool-call/approve {"toolCallId":"c2","via":"slack"} …

data: {"kind":"approval-settled","id":"c2","status":"approved","decidedBy":"admin-7","decidedVia":"slack"}

data: {"kind":"tool-output","id":"c2","output":{"refunded":true}}

data: {"kind":"step-finish","costUsd":0.0021}

data: {"kind":"step-start"}

data: {"kind":"text","text":"Done — the refund is on its way."}

data: {"kind":"step-finish","costUsd":0.0004}

event: done
data: {}
```

A client that reconnects while the run is parked (`GET <base>/chat/run_1/stream`) gets every frame
above from the beginning again, including the `approval-requested`, so the approval card is rebuilt
without a thread re-fetch.
