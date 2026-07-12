---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
---

Agent run tracing — every run now emits diagnostics SPANS correlated by `traceId = runId`, so the
Telescope TRACES tab renders the turn as a nested waterfall (llm calls, tool executions, retrieval,
follow-ups, with durations and error phases):

- core: four span events (`llm.turn`, `tool.execution`, `retrieval`, `follow-ups`) on the agent
  diagnostics channel, emitted from INSIDE the checkpointed step bodies — replayed (cached) steps
  never re-emit. Payloads are metadata-only (model id, token counts, tool name/type, step index —
  never prompt/output text). `traceLlmTurn`/`traceToolExecution` are exported for remote execution
  sites.
- nestjs: the dispatched-step handlers (`AgentRunSteps.llm`/`.tool`) emit the identical spans from
  whichever worker actually executes; the dispatch envelopes gained the additive fields the span
  identity needs (`step` on the llm input; `toolCallId`/`toolType` on the tool input).

Rendering requires the span-aware diagnostics bridge (`@dudousxd/nestjs-diagnostics-telescope`
0.7+) and `@dudousxd/nestjs-telescope` 1.17+ (explicit `RecordInput.traceId`); without them the
spans are emitted but unobserved (zero cost — phase envelopes are gated on subscriber presence).
