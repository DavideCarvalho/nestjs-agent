---
'@dudousxd/nestjs-agent-core': patch
'@dudousxd/nestjs-agent': patch
---

Run a turn's read tool calls concurrently instead of one at a time.

A model routinely asks for several tools in one turn, and the loop executed them back to back — two
independent three-second reads cost six seconds. They now overlap, and the turn costs the slowest
call rather than their sum.

What made this a determinism problem rather than a `Promise.all` is that the loop body is replayed
by the durable engine, which hands out checkpoint positions from a monotonic counter as the body
runs. Interleaving whole per-call blocks would order those positions by whichever tool happened to
finish first, which differs between a run and its replay. Under dispatched steps it is worse than a
`NonDeterminismError`: every dispatched tool call checkpoints under the SAME routing name, so a
swapped pair raises no refusal at all and simply hands one call's output to another.

So only the INVOCATIONS overlap. The `persist:toolcall` claims before them and the
`persist:toolexec`/`persist:toolfail` writes after them stay strictly sequential in call order, and
the invocations are all launched in one tick — both durable step primitives take their position on
the call, before their first `await`, so the block is pinned in call order however the tools then
settle. A turn is eligible only when every call's journaled kind is `read`: an `action` suspends on
a human approval (parallelism buys nothing, and reserving an invocation position for a call that may
be rejected spends a position the rejected branch never fills), and an `agent` delegation is
`ctx.child`, whose parallel form is the runtime's own `ctx.all`.

Two new optional `AgentLoopHooks`, so core stays runtime-agnostic:

- `parallel(tasks)` — run tasks concurrently, resolve once EVERY one has settled, outcomes in input
  order. Its absence keeps the loop sequential, which is the honest answer for a runner that assigns
  positions anywhere other than the call. `settleAll` is the implementation both bundled runners
  pass. Settling all of them is load-bearing: a durable runner unwinds a turn by throwing, and a
  sibling abandoned part-way through its own dispatch is a tool nobody ever runs.
- `patched(id)` — the runner's version gate (`ctx.patched`). Batching moves the `persist:toolcall`
  checkpoints ahead of the first execution, so a run that suspended mid-turn under the old shape
  keeps replaying against that shape instead of failing its resume.

A turn with fewer than two calls, or one the runner has not opted in for, records exactly the
checkpoint sequence it always did.
