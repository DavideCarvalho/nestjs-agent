---
"@dudousxd/nestjs-agent-opencode": minor
---

Turn limits, stops and lifecycle hooks.

- `limits: { steps, compactions, wallClockMs }` (fixed or per turn) counts OpenCode's own `session.step.started` and `session.compaction.started` events for the turn's session. A limit of N allows N.
- When a bound passes, the session is aborted. The turn ends `failed` with `outcome.stop = { reason, counts }` and code `opencode_stopped`, or, if its answer was already settling, keeps the answer with the stop still reported.
- `OpenCodeTurns.stopTurn(turnId, reason)` stops a turn for the app's own reason. It aborts only while that turn still owns its session and the thread's store holds it (`'unconfirmed'` when the store cannot be read). It refuses the ask of a turn parked on a person.
- `onTurnStart`, `onTurnEvent`, `onStop` and `onTurnEnd`, on the options or the host, run in the process that executes the turn's steps. Each `onTurnStart` is paired with exactly one `onTurnEnd` in that process (`released` when another worker takes the turn over or on shutdown). Only `onTurnStart` is waited for, up to `hookTimeoutMs`.
- The durable workflow's result carries `stop`.

Without these options nothing changes.
