---
'@dudousxd/nestjs-agent': minor
---

`dispatchedSteps` now defaults to ON under `durable: true` (opt out with `dispatchedSteps: false`).
The cross-process-sink requirement was never specific to dispatched steps — under `durable: true`
the turn already runs on whichever worker takes `agent.run`, which may not hold the SSE connection
— and the `AgentRunSteps` worker groups are always registered, so the routed steps are never
unserved. Dispatching the model call and tool executions is the correct production posture: the
run leaves its pod during the two long steps and the llm step gets engine retry.

Upgrade note: a run in flight across a deploy that changes the effective mode replays with
different step kinds and fails that one turn (send the message again). Multi-pod fleets should
already be on a cross-process sink (e.g. `RedisTokenStreamSink`) for durable streaming; the boot
warning now names `dispatchedSteps: false` as the alternative.
