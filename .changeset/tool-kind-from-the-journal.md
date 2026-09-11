---
'@dudousxd/nestjs-agent-core': patch
'@dudousxd/nestjs-agent': patch
---

Resolve a tool call's kind inside its `persist:toolcall` checkpoint instead of in the loop body.

The kind decides the call's control flow — an `action` suspends the run on an approval signal
(`signal:tool:<runId>:<callId>`), anything else records a step — and it was read from
`deps.registry` in the workflow body, so the branch depended on the registry of whichever process
ran it. A process whose registry lacks the tool (a module that never declared it, a surface that
mounts no tools, a pod still booting) read `undefined`, fell back to `'read'`, and asked for a
`tool:` checkpoint where the history held `signal:tool:` — `NonDeterminismError` on resume. Where
the execution is dispatched, that same misresolution sent the call on to a worker that DOES have
the tool, running an action nobody approved.

The lookup now happens inside the already-journaled `persist:toolcall:<callId>` step and is
returned from it, so replays read the recorded kind instead of asking their own registry. Same step
name at the same position, so in-flight runs keep replaying. `AgentRunSteps.tool` additionally
refuses to run a tool its own registry knows as an `action` when the dispatch says it was
auto-executed.

Replay-integrity failures now propagate out of the agent loop and the `agent.run` workflow
untouched. Both `catch` blocks reacted to one by writing more checkpoints — a `persist:toolfail`, a
`persist:run:fail`, a `deactivate` — and on a journal that has already diverged each of those asks
for a position the history cannot supply, so the recovery attempt raised its own refusal and THAT
is what surfaced: a message naming the wrong seq and two checkpoints from the recovery path rather
than the two that actually disagreed. The workflow still settles the stream, so a subscriber does
not hang on a run the engine is about to fail.
