---
'@dudousxd/nestjs-agent': patch
---

A tool that starts a workflow no longer breaks the durable run it was called from.

A class-first static routes by the ambient workflow ctx, and a tool's `execute` ran with the agent
run's ctx still ambient — in a `ctx.localStep` body, and in a dispatched `@Step` handler too when the
transport delivers in-process. So a tool that called `SomeWorkflow.start(...)` (directly, or through
a service) had it turned into `ctx.startChild`, which wrote a `spawn:<id>` checkpoint into the AGENT
run's journal from inside the step. A replay skips a completed step's body, so the next resume
offered that position to `persist:toolexec:<callId>` and the runtime failed the run:

```
non-determinism at <run>#20: code expects "persist:toolexec:call-…" but history recorded
"spawn:…". The workflow changed under an in-flight run — register a new @Workflow version.
```

It took a resume AFTER such a tool — two actions awaiting approval in the same step, or an approval
in a later one. Every checkpoint body of the agent workflow, and both dispatched step handlers, now
run outside the ambient workflow ctx: a workflow started from a tool is a run of its own, and the
step's recorded result keeps a replay from starting it twice. Ported from `@adonis-agora/agent`
0.52.1.
