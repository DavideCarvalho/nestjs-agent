# Capability parity with `@adonis-agora/agent`

This library and [`adonis-agent`](https://github.com/DavideCarvalho/adonis-agent) are the same
product on two frameworks. A consumer who picks one should not get the lesser agent, so the goal is
parity of **capability** — not of signature. Where a framework's idiom differs, the idiom wins and
the row says so.

The two drifted apart without anyone noticing, in both directions at once, which is why this file
exists: divergence should be a line in a table, not something a reader discovers.

## Where a capability is built

**This repo is the reference implementation.** New capabilities land here first and reach
`adonis-agent` in consolidated catch-up passes, not feature by feature. That is a deliberate trade:
porting a design that is still moving means porting it twice, and the second port is the one that
has to reconcile whatever changed in between.

The cost is that `adonis-agent` is *expected* to trail. A `not ported` row is therefore a normal
state, not a defect — what would be a defect is a row that is missing, because then nobody knows the
gap exists. The one thing that does not trail is a fix for a bug that exists in both: those port
immediately, because the bug is already running in production on both sides.

A capability that originates in `adonis-agent` (the MCP server) still gets built here before it
counts as shared, so the reference stays the superset.

## The rule

Adding a capability to either repo means adding its row here, with a status for the other side.
`not applicable` is a fine status; `not ported` is a fine status. Silence is not.

## Ledger

| Capability | `nestjs-agent` | `adonis-agent` | Notes |
|---|---|---|---|
| Tool kind resolved inside the journal | yes | yes | The branch that decides HITL-vs-execute must not read a process-local registry. |
| Replay-integrity errors propagate untouched | yes | yes | Adonis matches three spellings of the runtime's error class; NestJS two. |
| Control-flow signal detected by marker | yes | local predicate | Adonis carries its own predicate in the workflow rather than one in core. Same effect, different home. |
| Conversation history ceiling | `HistoryPolicy` — message count, token budget, optional summarization | `HistoryWindow` — same capabilities | Deliberately NOT the same name. Both own *selection*; the richer options are being aligned. |
| Message carries its `runId` | yes | yes | Without it a turn can only be attributed to a run by timestamp, which regeneration breaks. |
| Every `appendMessage` field round-trips | yes | yes | `attachments` was silently dropped by two of three NestJS adapters until a round-trip test existed. |
| A turn's tool RESULTS reach a thread reader | yes — `setMessageToolResults`, required on the SPI | not ported | The loop wrote outputs to the tool-call table only, so on Drizzle and in-memory every tool in a reopened thread stayed "running" forever. One write, one behaviour, three adapters — not three rebuilds that happen to agree. |
| Retrieval + structured output delivered as ordinary tool calls | yes | not ported | Both were tool-call ROWS only: invisible to every client, live and on reload. They now ride the message and the stream like any other call, so a client that renders tool calls renders them with no change. |
| A turn's read tool calls run concurrently | yes | yes | Safe only because both durable step primitives take their checkpoint position synchronously on the call. |
| Long steps dispatched to a worker fleet | yes | not applicable | Adonis has no dispatched-step split; tool execution always runs in the process that ran the body. |
| MCP **client** (import a server's tools) | yes | not ported | Imported tools default to `action`, so a remote tool of unknown effect is HITL-gated. |
| MCP **server** (expose this agent's tools) | to build | yes | Originated in Adonis; gets built here so the reference stays the superset. |
| Evals / scorers | yes | not ported | Includes mining HITL rejections as human-labelled negatives. |
| Input / output processors | in progress | not started | |
| Structured output | in progress | not started | |
| Ask the user a structured question | yes — configured intake + model-callable `ask` | not ported | Both surfaces write ONE persisted shape and park on the approval signal, so a consumer cannot tell which asked. |
| Skills (scoped, progressively disclosed procedures) | yes | not ported | Scoped by an opaque token a host resolver orders, not an enum: a new axis is a resolver change rather than a migration. The catalog rides the system prompt (one line each), the bodies ride the transcript under the history ceiling, and both the resolved scopes and the loaded body come out of the journal. |
| Detached subagents (chat stays free) | planned | not started | Changes the thread model from one active run to N live runs. A human reply now routes by the tool call's OWN `runId`, so it no longer needs the thread to hold exactly one. |
| Working memory (scoped, agent-written, forgettable) | yes | not ported | Same scope tokens and the same `ScopeResolver` as skills, so one deployment has one answer to "which scopes does this actor have". Departs from skills where memory genuinely differs: the entry carries the beaten VALUE rather than only its scope, `forget` is required on the provider while `write` is optional, and there IS a read/delete HTTP surface — a skill's author knows it exists, the subject of a memory does not. |
| Relevance selection over memory (`MemoryProvider.search`) | yes | not ported | The prompt budget is bounded; the store is not. Selecting the block by SCOPE starves the widest scopes first, so one person's twentieth note ends every chance their organisation's facts had — silently, behind a non-zero `omitted`. Scope stays a hard filter that gates before ranking; it stops being the ranking. The host owns the index (omit `search` and every turn is a plain scoped read, unchanged), the library owns resolution, precedence, budget and journal. The search runs INSIDE `memory:digest`, so every replay reads back the selection the first attempt made. |
| Always-on memories (`MemoryRecord.pinned`) | yes | not ported | Categorical, not a priority number: a number inflates, carries no reviewable meaning, and competes with relevance, which is already a continuous ordering. A category becomes a budget instead — pinned taken from `maxMemories` first, overflow reported as `pinnedOmitted` because that omission is a misconfiguration rather than a budget. An agent cannot pin its own writes; `StoreMemoryInput` has no such field, the same enforcement-by-shape that keeps `scope` off the `remember` tool. |
| Memory block framed by `origin.author` | yes | not ported | A wide-scope memory is usually PUBLISHED by an administrator, not concluded by the agent. One framing over the whole block told the model to treat an organisational decision as its own guess and to "prefer what the user says now" about it — which hands any user an override of company policy by assertion. Two sections: what a person stated is an instruction, what the agent concluded is hedged. |
| Semantic recall over a transcript | not started | not started | Still a different feature, and still not folded into memory: searching what was SAID is retrieval over messages, and `Retriever`/`Reranker`/`EmbeddingProvider` already exist for it. Memory searches CONCLUSIONS. |

The round-trip row is worth a note in both directions. NestJS was dropping `attachments` in two of
three adapters; Adonis was not, but was dropping `persona` in both of its own. Neither was findable
by reading either repo — the check that finds them is a fixture typed
`Required<Omit<AppendMessageInput, …>>`, so a new optional input field fails to COMPILE until it is
covered. That technique originated in Adonis and was brought back here.

## What parity does not mean

- **Not the same API surface.** `HistoryPolicy` and `HistoryWindow` solve one problem under two
  names because each already fit its own repo. Renaming one to match would break its consumers to
  buy nothing.
- **Not the same internals.** Adonis resolves a denied delegation inside the same checkpoint that
  settles the tool kind, because its loop had a fourth persist site NestJS does not have.
- **Not every row.** A capability that only makes sense against one framework's runtime (dispatched
  steps) is marked `not applicable` and stays that way.
