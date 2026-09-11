---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
---

Add a `HistoryPolicy` seam so a turn no longer carries the entire thread.

The loop mapped every message `getThread` returned into the model's messages, with no window, no
budget and no summarization. A long-lived thread therefore grew until the provider rejected the
request outright, and every turn before that one paid for the whole transcript — the lib priced that
spend and enforced a quota against it, but nothing bounded what generated it.

`AgentModule.forRoot({ history: { maxMessages, maxTokens } })` keeps the newest messages that fit,
and `@Agent({ history })` lets one persona set a tighter ceiling than the module's. Adding
`summarize: true` folds what the window left out into a leading `system` summary, produced by one
extra model call and recorded as a `history_summary` usage row so bounding context cost cannot
itself become spend nothing accounts for. `historyPolicy` takes a `HistoryPolicy` of your own for a
window the built-in cannot express; `windowHistory`, `summarizeWithModel` and `estimateMessageTokens`
are exported for composing one.

Nothing changes for a consumer who configures none of this: the turn still carries the whole thread,
and the loop's checkpoint names and positions are byte-identical, so a run already in flight keeps
replaying. Selection is deliberately a pure function called OUTSIDE any checkpoint — that is what
lets a policy exist without moving a position — and summarization, which calls a model, runs inside a
`history:summarize` checkpoint so a resumed run reads back the summary the suspended attempt
produced rather than prompting with a different one.

`UsagePurpose` gains `'history_summary'`. Both shipped stores persist `purpose` as text, so no
schema change is needed; widen your own store's column if it constrains the value.

Detect durable control-flow signals in core instead of relying on the host to.

`AgentLoopHooks.isControlFlowError` is optional, so a host that omitted it had every durable suspend
swallowed by the tool try/catch and written to the journal as a tool failure — a run that should have
resumed on approval instead came back as a failed call, and the replay it left behind could not line
up. The loop and `invokeWithTransientRetry` now recognize the `Symbol.for('aviary:durable:control-flow')`
marker the durable runtimes stamp on their signals, checked as a property so it works across the two
packages that raise them and across duplicate module copies. Core gains no dependency on either
durable package. The hook remains, as an override for a runner whose signals carry no marker.
