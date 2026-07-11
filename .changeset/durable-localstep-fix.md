---
'@dudousxd/nestjs-agent': patch
---

Fix `durable: true` under nestjs-durable >= 0.31 (core >= 0.50): `AgentRunWorkflow` now checkpoints
the turn's steps with `ctx.localStep` instead of `ctx.step`. Since durable's single-step collapse,
`ctx.step(name, input)` is ALWAYS dispatched — the name becomes a routing worker-group and the
closure was silently serialized away as "input", so every agent step landed on a queue no worker
serves (`persist-user@<tenant>`, `deactivate@<tenant>`) and the run suspended forever. The agent
loop's steps are closures over in-process turn state (model provider, open SSE sink) with dynamic
checkpoint-identity names, which is exactly what `localStep` is for — same durability (checkpointed
outputs, replay skips completed steps, HITL suspend/resume), no dispatch.

Durable peer floors raised to match: `@dudousxd/nestjs-durable >= 0.34.0`,
`@dudousxd/nestjs-durable-core >= 0.51.0` (the versions that expose `localStep` on `WorkflowCtx`).
