---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-react": minor
---

Regenerate, per-tool timeouts, and follow-up suggestions.

- **Regenerate.** `AgentRunInput.regenerate` (and `chat({ regenerate: true })` / the `regenerate` chat-body field) re-runs the last exchange: the loop truncates everything after the thread's last user message and re-answers it, instead of appending a duplicate. `useAgentChat` exposes a `regenerate()` that flags the next request. Requires an existing `threadId` (and, over HTTP, ownership of it).
- **Per-tool timeout.** `AgentModule.forRoot({ toolTimeoutMs })` aborts a tool that runs longer than the limit and records it as failed — the model receives the timeout as its result and can adapt — instead of hanging the turn.
- **Follow-up suggestions.** `AgentModule.forRoot({ followUps: true | { count } })` makes one extra model call after the final turn to propose short follow-up questions, stored on the assistant message's `followUps` and recorded as `follow_ups` usage. Off by default.
