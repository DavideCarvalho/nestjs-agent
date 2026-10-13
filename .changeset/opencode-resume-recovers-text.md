---
'@dudousxd/nestjs-agent-opencode': patch
---

A durable turn whose API restarted while OpenCode worked no longer settles as an empty success. The re-run `observe` step re-attached and caught up on open permissions and forms only, so the text, tool calls and usage OpenCode streamed meanwhile were lost and the turn ended `succeeded` with no text and zero usage. Now the rebuilt turn, when the execution ends, reads back the session's messages after the turn's prompt (the prompt carries the run id in its `metadata`) and takes what it missed as the events would have — less what was taken before the restart, journaled with each `ask` milestone (`TurnProgress`), so nothing is persisted or counted twice. A session that left no answer for the turn fails it with `LOST_ANSWER_ERROR` instead. `OpenCodeClient.message.list` now types the messages (`OpenCodeMessage`) and takes a `cursor`; `session.prompt` takes `metadata`.
