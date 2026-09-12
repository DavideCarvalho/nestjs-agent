---
'@dudousxd/nestjs-agent': patch
---

`DurableAgentRunner.cancel` no longer lets a run-gateway read failure stop the cancel.

The thread a run was streaming is read off the run's recorded input so the active stream can be
cleared. That read was on the critical path: if `getRunDetail` rejected — a transient gateway, an
operator briefly unreachable, a tenant's transport proxy timing out — `cancel` threw before reaching
`runs.cancel`, so the run was never told to stop, the stream never got its `cancelled` frame or its
terminal, and the run row never got its own. A subscriber then waits on a stream that never settles,
from the one call whose entire job is to make a run stop.

The read is now best-effort: the thread is resolved if the gateway can answer, `undefined` if it
cannot, and the cancel, the stream's terminal and the run's terminal happen either way. That mirrors
the posture `AgentRunWorkflow.isCancelled` already takes for the same gateway on the same run —
failing to ask is not an answer worth failing a run over. Nothing is guessed at: with no thread named,
no thread is released.
