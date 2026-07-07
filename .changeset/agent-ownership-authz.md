---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-testing": minor
"@dudousxd/nestjs-agent-store-mikro-orm": minor
"@dudousxd/nestjs-agent-store-drizzle": minor
---

Enforce per-actor ownership on the governance endpoints (security fix).

`ToolCallController.approve`/`reject` and `ThreadsController` detail/delete/fork previously acted on a raw `runId`/`threadId` with no ownership check — any caller who reached the endpoint could approve another run's `action` tool or read/delete another actor's thread (an IDOR). They now resolve the acting actor and assert ownership: a foreign target is `403`, a missing one `404`.

- **Breaking (SPI):** `AgentStore` gains `ownerOfThread(threadId)` and `ownerOfToolCall(toolCallId)`. Custom store adapters must implement them; the bundled MikroORM, Drizzle, and in-memory stores already do.
- **Breaking (API):** `AgentService.approve`/`reject` and `getThread`/`deleteThread`/`forkThread` now take the resolved `Actor` as their first argument (the controllers resolve it via the `ActorResolver`).
