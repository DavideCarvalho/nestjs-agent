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
| A turn's tool RESULTS reach a thread reader | yes — `setMessageToolResults`, required on the SPI | yes | The loop wrote outputs to the tool-call table only, so every tool in a reopened thread stayed "running" forever — on both sides. One write, one behaviour, every adapter — not N rebuilds that happen to agree. Adonis writes it at a `persist:toolresults:<step>` of its own, because it has no `stream:tool-outputs` checkpoint to ride: that is a new position, so `ctx.patched('agent:message-tool-results')` gives it back to a run suspended under the older shape. Its configured intake does the same inside `intake:answers`, off a message id `intake:ask` now returns. |
| Retrieval + structured output delivered as ordinary tool calls | yes | yes | Both were tool-call ROWS only: invisible to every client, live and on reload. They now ride the message like any other call, so a client that renders tool calls renders them with no change. NestJS also rides the stream; Adonis has no tool frame on its `StreamFrame` union (text / component / elicitation), so there is no live half to port — delivery is the message, and the checkpoint names and positions are unchanged either way. |
| A turn's read tool calls run concurrently | yes | yes | Safe only because both durable step primitives take their checkpoint position synchronously on the call. |
| Long steps dispatched to a worker fleet | yes | not applicable | Adonis has no dispatched-step split; tool execution always runs in the process that ran the body. |
| MCP **client** (import a server's tools) | yes | not ported | Imported tools default to `action`, so a remote tool of unknown effect is HITL-gated. |
| MCP **server** (expose this agent's tools) | to build | yes | Originated in Adonis; gets built here so the reference stays the superset. |
| Evals / scorers | yes | yes | Includes mining HITL rejections as human-labelled negatives. Adonis reads only `AgentGovernanceQueries`: its `runDetail` already returns the run's OWN messages, so there is no transcript join and no time-window fallback to get wrong. No paged tool-call feed there, so the approval prior comes from the batch's own runs or the bounded activity feed. |
| Input / output processors | yes | yes | Adonis's sink carries a typed `StreamFrame` rather than bytes, so there is no frame a gate cannot classify and the buffer rides a checkpoint as-is. Its providers report tool calls only when `runTurn` returns, so an incremental prefix pass sees none until the authoritative whole-answer pass. No dispatched-step fallback and no follow-ups to gate. |
| Structured output | yes | yes | Both deliver the value on the message as a synthetic `structured_output` tool call. Adonis's loop feeds tool results back as an EMPTY `user` message, so the restatement prompt takes the last user message WITH CONTENT — scanning for the last `user` role handed the pass a blank question on every turn that called a tool. |
| Ask the user a structured question | yes — configured intake + model-callable `ask` | yes | Both surfaces write ONE persisted shape and park on the approval signal, so a consumer cannot tell which asked. Settled answers now land on the asking message in both. |
| Skills (scoped, progressively disclosed procedures) | yes | yes | Scoped by an opaque token a host resolver orders, not an enum: a new axis is a resolver change rather than a migration. The catalog rides the system prompt (one line each), the bodies ride the transcript under the history ceiling, and both the resolved scopes and the loaded body come out of the journal. Adonis appends the built-in from `withBuiltInTools({ tools, ask, skills, memory })` rather than a `withSkillTool` of its own, since it has no dispatched llm step re-deriving the list on a worker. No `/`-autocomplete surface there yet: the catalog reaches the model, not a composer. |
| Detached subagents (chat stays free) | yes | not started | Declared per EDGE (`handoff: [{ agent, detached: true }]`), never by the model — a model that can detach can detach the thing the user is waiting on, and cannot know which that is. The branch is settled inside `persist:toolcall` next to the call's kind and target, so the loop writes the SAME checkpoint names either way and only the runner's positions differ (`spawn:` vs the awaited child's `signal:child:`). The turn's result is a receipt, not an answer; the answer arrives as its own message stamped with the child's `runId`/`agentName`. A detached run owns its sink and parks its `action` tools on its own run, so its approval reaches the inbox instead of an inline card in whatever turn is open. A human reply already routed by the tool call's OWN `runId`, which is what made a thread with N live runs possible at all. |
| Working memory (scoped, agent-written, forgettable) | yes | yes | Same scope tokens and the same `ScopeResolver` as skills, so one deployment has one answer to "which scopes does this actor have". Departs from skills where memory genuinely differs: the entry carries the beaten VALUE rather than only its scope, `forget` is required on the provider while `write` is optional, and there IS a read/delete HTTP surface — a skill's author knows it exists, the subject of a memory does not. Adonis serves that surface as `GET`/`DELETE <path>/memories` off the provider's router, mounted whether or not memory is configured (unconfigured answers as though nothing is on file, rather than 404ing a capability a client cannot probe for). |
| Relevance selection over memory (`MemoryProvider.search`) | yes | yes | The prompt budget is bounded; the store is not. Selecting the block by SCOPE starves the widest scopes first, so one person's twentieth note ends every chance their organisation's facts had — silently, behind a non-zero `omitted`. Scope stays a hard filter that gates before ranking; it stops being the ranking. The host owns the index (omit `search` and every turn is a plain scoped read, unchanged), the library owns resolution, precedence, budget and journal. The search runs INSIDE `memory:digest`, so every replay reads back the selection the first attempt made. |
| Always-on memories (`MemoryRecord.pinned`) | yes | yes | Categorical, not a priority number: a number inflates, carries no reviewable meaning, and competes with relevance, which is already a continuous ordering. A category becomes a budget instead — pinned taken from `maxMemories` first, overflow reported as `pinnedOmitted` because that omission is a misconfiguration rather than a budget. An agent cannot pin its own writes; `StoreMemoryInput` has no such field, the same enforcement-by-shape that keeps `scope` off the `remember` tool. |
| Memory block framed by `origin.author` | yes | yes | A wide-scope memory is usually PUBLISHED by an administrator, not concluded by the agent. One framing over the whole block told the model to treat an organisational decision as its own guess and to "prefer what the user says now" about it — which hands any user an override of company policy by assertion. Two sections: what a person stated is an instruction, what the agent concluded is hedged. |
| A turn reads a bounded window of the thread | yes — `ThreadTurnReader` in core, the loop calls it, both SQL stores implement it | not ported | A turn needs the last few messages, the title, and whether the thread was ever answered; `getThread` hands it the transcript, and the run then journals what it loaded — 1.9 MB per load on a 50-turn thread whose turns each ran a 50 KB tool, 97% of it tool results. The bound is the database's (`order by created_at desc limit ?`), and `hasAssistantMessage` is still answered over the WHOLE thread, or a long thread whose window holds only questions re-introduces itself every turn. Probed structurally like `defaultAgentForThread`, so a store without it still answers through the full read. The bound handed to the store is `HistoryPolicy.maxMessages`, omitted for a summarizing policy (whose `summarize` is handed what `select` DROPPED — a read bounded to what it keeps would fold an empty summary into a prompt missing the messages it stands in for) and for a token-only ceiling (no row count follows from a token budget). Which read ran is invisible to the journal: the `load:thread` payload is identical either way, so no patch marker and no checkpoint moved. |
| A child run records which run delegated it | yes — `parent_run_id` on all three stores | not ported | The parent->child edge was journaled by the durable runtime and nowhere else, so every reliability and cost surface — which reads run ROWS — saw a delegation's spend as an orphan turn. Detached children make it sharper: one outlives its parent's turn, so the transcript cannot pair them either. The field was already on the SPI input and passed by both runners; all three adapters dropped it because each re-declared `recordRunStart`'s parameter instead of taking `RecordRunStartInput`. They now take the input itself, and each spec round-trips a `Required<RecordRunStartInput>` fixture. |
| A delegation cycle is detected as a cycle | yes — `AgentRunInput.delegationPath`, both runners thread it | not ported | The depth ceiling was a proxy: it could say a chain was LONG, never that it was going in circles. A mutual handoff ran five agents deep and reported `depth limit of 5 reached`, which leaves a reader to work out which of the two faults they have — and refused a chain of six DISTINCT agents for resembling one. The chain of agent names costs exactly what the counter cost to thread, so the loop now compares the target against its own ancestry: a repeat IS the cycle, named in the refusal (`alpha → beta → alpha`) with the number of appearances. `maxAgentAppearances` defaults to 1 and is the count of appearances, so 2 admits exactly one deliberate return. Depth stays as the backstop for a chain that is merely long. A runner that threads no chain falls back to depth alone, unchanged. |
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
