---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
---

Dispatched turn steps — opt-in `dispatchedSteps: true` (requires `durable: true`) dispatches the
turn's two LONG steps as routed durable steps instead of in-process localSteps, so a run is no
longer pinned to its pod while the model call or a tool executes:

- `AgentRunSteps.llm` (`@Step({ retries: 3 })`): resolves the model/sink/tool definitions from the
  serving worker's own DI and streams from wherever it runs. `AgentRunSteps.tool` (no retries —
  tool idempotency is the app's domain): rebuilds the tool ctx and applies the tool timeout
  handler-side. Both are ALWAYS registered by `AgentDurableModule` (worker groups always served);
  the flag only controls dispatching. Bookkeeping steps (persist/quota/stream markers) stay local —
  dispatching a 10ms DB write through a queue buys nothing.
- Core: serializable `LlmStepEnvelope`/`ToolStepEnvelope` (`ToolStepCtx` excludes `host`, re-attached
  from DI handler-side; the llm envelope carries the `actor` and the handler re-derives tool
  definitions — live schema instances never cross the wire), optional `dispatchLlm`/`dispatchTool`
  loop hooks (absent = behavior identical to before), exported `withToolTimeout`.
- Core: new `AgentLoopHooks.isControlFlowError` — the durable runner's suspend/continue-as-new
  signals now escape the loop's tool catch instead of being mispersisted as tool failures (which
  diverged on replay).
- Multi-pod fleets MUST wire a cross-process token sink (e.g. `RedisTokenStreamSink`); a boot
  warning fires when `dispatchedSteps` is on with the default in-process sink.
