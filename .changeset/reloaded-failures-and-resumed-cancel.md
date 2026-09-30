---
'@dudousxd/nestjs-agent-react': patch
---

Two things a reloaded chat got wrong. A tool call that failed — it threw, or its turn died before it was settled — reloaded as `output-available`, so an approval card drew an action that never ran as done; `storedMessageToUiMessage` now answers `output-error` with the stored reason, the state the live stream leaves it in. And `cancel()` did nothing on a run the chat had re-attached to after a reload: that stream opens with no `meta` frame, so the hook never learned the run's id — it now takes it from the attach (`AgentChatTransport`'s new `onResumeAttached`), which also makes `onRunSettled` fire for a re-attached run. `cancel()` also reads the thread's queue back when messages are waiting, so the pause a Stop puts on the queue shows at once instead of after the next reload.
