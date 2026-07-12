---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
---

Retry a classified-transient tool error (DB deadlock, lock-wait timeout, serialization failure) in
place — no new durable checkpoint, just repeated attempts inside the same tool-call step:

- `isTransientToolError` (core): structural classifier for MySQL (`ER_LOCK_DEADLOCK` /
  `ER_LOCK_WAIT_TIMEOUT`, codes `1213`/`1205`), Postgres (SQLSTATE `40001`/`40P01`), `SQLITE_BUSY`,
  and a matching `deadlock|lock wait timeout|serialization failure` message — checked on the error
  and one level of `cause`.
- `invokeWithTransientRetry` (core): wraps a thunk with `{ attempts, backoffMs, classify }`,
  rethrowing immediately on a non-transient or control-flow error.
- `toolTransientRetry` option (on the same surface as `toolTimeoutMs`): default ON
  (`{ attempts: 2, backoffMs: 150 }` with the default classifier); `{ classify }` to widen/narrow;
  `false` to disable. Wired at BOTH execution sites — the local agent-loop path and the
  durable-dispatched `AgentRunSteps.tool` handler (via `ToolStepEnvelope.transientRetry`'s
  wire-safe numeric half; a custom `classify` never rides the wire, resolved from local module
  options on the serving worker instead).
- New `aviary:agent:tool.retry` diagnostics point event (`{ toolName, toolCallId, attempt, message
  }`) emitted per retry.
