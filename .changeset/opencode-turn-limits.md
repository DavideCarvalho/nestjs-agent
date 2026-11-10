---
"@dudousxd/nestjs-agent-opencode": minor
---

Turn limits, stops and lifecycle hooks. `limits: { steps, compactions, wallClockMs }` (fixed or per turn) counts OpenCode's own `session.step.started` and `session.compaction.started` events for the turn's session and aborts the session when a bound passes; the turn ends `failed` with `outcome.stop = { reason, counts }` (code `opencode_stopped`), or keeps an answer that was already settling with the stop still reported. `OpenCodeTurns.stopTurn(turnId, reason)` stops a turn for the app's own reason, only while that turn still owns its session. `onTurnStart`, `onTurnEvent`, `onStop` and `onTurnEnd` (on the options or the host) run in the process that executes the turn's steps, `onTurnStart` with `resumed: true` on a worker that took the run over. The durable workflow's result carries `stop`. Without these options nothing changes.
