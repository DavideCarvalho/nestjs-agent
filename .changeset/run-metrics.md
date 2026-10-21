---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-opencode": minor
"@dudousxd/nestjs-agent-store-drizzle": minor
"@dudousxd/nestjs-agent-store-mikro-orm": minor
"@dudousxd/nestjs-agent-testing": minor
"@dudousxd/nestjs-agent-dashboard": minor
"@dudousxd/nestjs-agent-telescope": minor
---

Run metrics: time to first token, cost and model on the run, and settle diagnostics with context.

- `run.finished` carries `durationMs`, `ttftMs` (turn start to the first non-empty `text` frame), `costUsd` (sum of the model calls with a known cost), `modelId` (the last call's) and the run's context (`actorId`, `agentName`, `tenantRef`, `parentRunId`). The start is the journaled `run:started-at` and the first-text instant is journaled with the checkpoint that wrote it, so a resumed run keeps its figures.
- `run.failed` gains `threadId`, `durationMs` and `context` (it keeps `message`); the new `run.cancelled` is published instead of it when a run is stopped — by the inline and durable runners and by OpenCode. `runDurationMs(error)` and `agentRunContext(input)` give a runner the same figures.
- `tool-call` gains `toolCallId` and `replayed: true` (an outcome re-published by a durable replay); its `durationMs` is now measured inside the `tool:<callId>` checkpoint, or on the worker for a dispatched call.
- `agent_run` gains nullable `ttft_ms`, `cost_usd` and `model_id` (in-memory, Drizzle — added by `ensureAgentSchema` — and MikroORM, schema revision 4); `RecordRunEndInput` and `RecentRunRow` carry them, and `RunMetrics` gains `ttftP50Ms`/`ttftP95Ms` over completed top-level runs.
- Dashboard: a TTFT stat in Reliability, TTFT/cost/model in the run detail, and `run.failed`/`run.cancelled` in the live feed. Telescope: a TTFT distribution and TTFT p50/p95 stats, failures by code and a cancelled count.
