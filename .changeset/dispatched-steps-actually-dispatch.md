---
'@dudousxd/nestjs-agent': minor
---

Dispatched steps now actually dispatch.

`AgentRunWorkflow` took `AgentRunSteps` as `@Optional() private readonly steps: AgentRunSteps |
undefined`. That is a union type, so TypeScript emits `Object` as its `design:paramtypes` entry, and
with no explicit `@Inject` token Nest had nothing resolvable to look up — `@Optional()` turned that
into `undefined` rather than an error. The class constructed fine, `AGENT_DISPATCHED_STEPS` read
`true`, and the workflow silently took the in-process fallback on every surface. No turn has ever
left its pod for the model call or a tool execution, whatever `dispatchedSteps` was set to. Existing
tests asserted behaviour, which is identical either way, so nothing caught it.

The dispatch decision no longer reads that instance at all. `ctx.step` routes by the `@Step`-stamped
name and never invokes the reference — the serving worker re-resolves the handler from its own DI —
so the names are read off `AgentRunSteps.prototype` and a pod that provides no `AgentRunSteps` (the
`'http'` surface, which registers the workflow only so `start()` can enqueue it) replays the same
branch instead of degrading to the in-process one and diverging from the history an engine pod
wrote. The constructor parameter is gone.

Which branch a turn takes changes the checkpoint names it writes, so it is gated on `ctx.patched`: a
fresh run dispatches, a run already journaled under the in-process names finishes on them. Upgrading
therefore does not strand in-flight turns.

**This changes deployed behaviour.** A multi-pod deployment will, for the first time, execute
`AgentRunSteps.llm`/`.tool` on whichever worker serves those groups. Confirm the groups are served
and that a cross-process `TokenStreamSink` is wired (the default in-process sink cannot stream a
turn whose model call ran elsewhere) before upgrading, or set `dispatchedSteps: false`.
