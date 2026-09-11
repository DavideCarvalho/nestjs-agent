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
| Detached subagents (chat stays free) | planned | not started | Changes the thread model from one active run to N live runs. A human reply now routes by the tool call's OWN `runId`, so it no longer needs the thread to hold exactly one. |
| Working / semantic memory | not started | not started | |

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
