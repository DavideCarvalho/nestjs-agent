---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
'@dudousxd/nestjs-agent-testing': minor
'@dudousxd/nestjs-agent-store-drizzle': patch
'@dudousxd/nestjs-agent-store-mikro-orm': patch
---

Let an agent ask the user a structured question, and wait.

The only way a run could pause for a human was `awaitApproval` — a yes/no about a tool call already
proposed, mid-work. The other direction was missing entirely: collecting the SCOPE, before the work,
while changing course is still cheap. Two surfaces now do it, and they were built to be
indistinguishable downstream.

**A configured intake.** `@Agent({ intake: { questions, preamble?, when? } })` declares the questions;
the turn passes through them before its first model call. Because they are authored, the intake costs
**no model call** and writes no usage row — and `questions.length` is known before the form appears,
which is the only honest way a client can render "Question 1 of 3" rather than discovering a fourth
halfway through. `when: 'thread-start'` (the default) asks once per thread; `'every-turn'` asks before
each one.

**A model-callable `ask`.** `forRoot({ ask: true })` (or `@Agent({ ask })`) offers the model a built-in
`ask` tool for the case an intake cannot anticipate. Its input schema *requires* a pre-picked
`defaults` on every question: "I have pre-picked what I would choose, so confirming is enough" is the
claim the surface rests on, and a schema is the only place to make it mandatory rather than
aspirational. A malformed question set comes back as an ordinary tool failure carrying the validation
issues, so the model fixes its own mistake instead of failing the run or parking a person.

**One shape, one resume path.** Both write a single pending tool-call row named `ask`
(`toolType: 'action'`, `status: 'pending_approval'`, so it surfaces in the existing approvals inbox),
both emit the same new `elicitation` stream frame followed by the ordinary `tool-output` frame, and
both park on the same `tool:<runId>:<callId>` durable signal a HITL approval already waits on. New
`POST /agent/tool-call/answer` and `/skip` mirror `approve`/`reject`, with the same ownership check.
`AgentLoopHooks` gains an optional `awaitAnswers`; a host that only implemented `awaitApproval` still
completes an elicitation, reading approve as "confirmed the pre-picked answers" and reject as "skipped".

**An omitted question takes its own default**, resolved server-side against the request the run
already holds rather than in the client — so "just pressed enter" and "picked exactly the defaults"
persist identically, and a client that never rendered the defaults cannot submit a blank. The settled
row records `defaulted: string[]` so an auditor can still see which questions a human touched.
**A skip is not a confirmation:** it lands on the same values, and persists as `rejected` rather than
`executed`, because proceeding on an assumption the user declined to confirm is a different fact from
proceeding on one they chose. Nobody answering parks the run indefinitely, exactly as an approval
does — there is no intake timeout, because a timeout that applied the defaults would manufacture
consent from silence.

`ToolKind` gains a fourth member, `'ask'`. No `ToolSpec` carries it: `ask` is never registered, has no
handler, and is offered to the model straight from module config — so the branch that decides whether
a call parks on a human can never be settled by a process-local registry lookup. As with the other
kinds, the value is resolved INSIDE the already-journaled `persist:toolcall:<callId>` checkpoint and
read back from there on every replay.

**Checkpoints.** An intake spends one position for its verdict (`intake:ask`) plus two more on the
turns it asks; an `ask` reuses the approval path's own names and adds one (`stream:elicitation:<id>`).
The intake's verdict is RETURNED from `intake:ask` rather than recomputed, because by the time a
resume replays the turn the first attempt has already appended the intake's own assistant message to
the thread — recomputing "has this thread been asked?" would answer no on the way in and yes on the way
back, and land `stream:step-start:0` where the history holds `signal:tool:`. No `patched` marker is
spent for either surface: an intake is reachable only through new config and an `ask` only through a
journaled kind no existing run recorded, so no in-flight run can land on any of these positions.
Declare neither and a turn's checkpoint sequence is byte-identical.

`AgentStore.runForToolCall` now answers from the tool call's OWN `runId`, falling back to the thread's
`activeStreamId` only for rows written before calls carried one. Keying off the active stream assumed
a thread holds exactly one live run; it is about to hold more, and then the answer would reach a run
waiting on nothing. Fixed in all three shipped adapters.
