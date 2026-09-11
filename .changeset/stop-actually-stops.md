---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
---

Make `cancel` cancel.

`POST /agent/chat/:runId/cancel` answered `{ aborted: true }` and the run carried on to completion,
tool calls included. The durable runner's `cancel` was `await Promise.resolve()`; the inline one only
ended the sink, so the stream went quiet while the loop kept spending. A Stop control now ships in
the React package on top of that, which turns a missing feature into a button that says "Stopping…"
and stops nothing — worse than not having it.

**The loop observes a cancel and unwinds.** `AgentLoopHooks.cancelled()` is asked at the points where
stopping is safe and cheap — between steps, before the next model call, and before a turn's tool
calls are dispatched — and a set flag throws `RunCancelledError`, which unwinds through the same path
a durable suspend already uses.

**A tool already executing is not interrupted, and that is the design rather than a gap.** There is
no un-executing a side effect, and abandoning a dispatched step mid-flight would leave the journal
holding a dispatch whose result never lands. A tool that has started runs to completion and is
recorded exactly as it would have been; the cancel is taken at the next point. So a cancel landing
mid-tool costs that one tool, and nothing after it.

**The observation is journaled, because the loop body is replayed.** `hooks.cancelled()` is only ever
called from inside a `hooks.step` checkpoint, so the first process to reach a position writes the
answer there and every replay reads it back. A cancel arriving between two replays is therefore seen
at the first position the history does not yet hold, and cannot change the branch a replayed position
already took. The positions themselves sit behind `hooks.patched('agent:cancellation')`, so a run in
flight when this ships keeps replaying against the sequence it recorded; a runner that wires no hook
adds no checkpoint at all.

**A cancelled run is distinguishable from a failed one and from a completed one.** `RecordRunEndInput.status`
gains `'cancelled'` — a third terminal, with no `errorCode`/`errorMessage`, so a consumer's failure
rate can leave a user pressing Stop out of it. On the wire, `AgentStreamEvent` gains `{ kind: 'cancelled' }`,
written as the stream's last frame before a normal `end()` — never a `fail()`, so a client that
retries a failed stream does not retry a deliberate stop, and a reader can tell a truncated answer
from a complete one. `agentFailureCode` answers `'cancelled'` rather than `'run_failed'`.

**Per runner.** The inline runner holds the request in-process and additionally REJECTS any wait
parked on a human, so a turn sitting on an approval stops immediately instead of waiting forever. The
durable runner calls the runtime's own cancel in its compensating form through `RUN_GATEWAY` (bound
under both durable topologies, unlike `WorkflowEngine`): that moves the run to `cancelling` — which is
what the workflow's cancel observation reads — and re-drives it, so an in-process turn unwinds at its
next safe point, child runs cascade, and a turn parked on `waitForSignal` still settles `cancelled`.
That last case is the one thing no in-body observation can reach: it is suspended inside a checkpoint
its journal already holds, so nothing new is ever evaluated there.

The runner settles the run row and the subscriber's stream (both keyed by run id alone); the run body
releases the thread's `activeStreamId`, because only it knows which thread the run was streaming.

Unknown stream frames are already ignored by the bundled transport, so a client that has not learned
`cancelled` sees the `end()` it always saw.
