---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-react": minor
"@dudousxd/nestjs-agent-store-mikro-orm": minor
"@dudousxd/nestjs-agent-store-drizzle": minor
"@dudousxd/nestjs-agent-testing": minor
---

Close the sub-agent HITL gap, and route approvals by tool-call id.

Previously a sub-agent's action tool could not get human approval: the inline runner auto-declined it, and the durable runner suspended on the child run's signal — a run the client never sees — so it hung until timeout. Now a delegated sub-agent's action tools go through the same human gate as the top-level agent.

- **A sub-agent streams into its top-level ancestor's sink.** A new `AgentRunInput.sinkRunId` carries the top-level runId down the delegation chain; a sub-agent forwards its tokens (and its pending action-tool frames) into the live stream the human is already watching, so the human can see — and therefore approve — it. The forwarding writer swallows `end`/`fail`: the top-level run owns the shared stream's lifecycle. Since the parent blocks awaiting the child, there is no interleaving.
- **Approve / reject route by tool-call id alone.** `POST /agent/tool-call/{approve,reject}` (and `AgentService.approve/reject`, and the React `approve/reject`) no longer take a `runId` — the server derives the exact run awaiting the call from a new `AgentStore.runForToolCall(toolCallId)` SPI (the tool call's thread's `activeStreamId`). That resolves to a sub-agent's own child run, which the client could never name, and drops the last client-supplied id from the HITL path.
- **Breaking (SPI):** `AgentStore` gains `runForToolCall`; custom store adapters must implement it. `AgentService.approve(actor, toolCallId)` / `reject(actor, toolCallId, reason?)` and the `/tool-call` request bodies drop `runId`.
