---
"@dudousxd/nestjs-agent-store-mikro-orm": minor
"@dudousxd/nestjs-agent-store-drizzle": minor
"@dudousxd/nestjs-agent-core": patch
"@dudousxd/nestjs-agent": patch
"@dudousxd/nestjs-agent-telescope": patch
---

Cut the statements and rows behind the reads that run on every send, attach, list and dashboard load.

- **Indexes** (both stores, every dialect; `ensureAgentSchema` adds them to a running database):
  `agent_thread(active_stream_id)` for the ownership read on every stream attach,
  `agent_tool_call(status, created_at)` for the approvals inbox, `agent_tool_call(run_id)`,
  `agent_tool_call(created_at)`, `agent_token_usage(created_at)`, `agent_token_usage(thread_id)`
  (Postgres had none on the foreign key) and `agent_message(thread_id, seq)`.
- **Quota**: `quotaToday` / `usageBetween` sum in the database instead of loading every usage row of
  the day and the month. New optional `AgentStore.usageWindows(actorRef, ranges)` sums several
  ranges in one statement; `LedgerQuotaProvider` uses it to read the day and month windows together.
- **`listThreads`**: the last-message previews are two batched reads instead of one full-row read
  per thread.
- **Sends**: new optional `ThreadSettingsReader.threadSettings(threadId)` answers a thread's owner,
  default agent, persona and model in one read; `AgentService.send` uses it instead of up to five
  separate reads. Both stores and the in-memory store implement it.
- **Writes**: the MikroORM store's `updateToolCall`, `setMessageToolResults`, `setMessageUi` and
  `setMessageFeedback` are one `UPDATE` instead of a load and a flush.
- **Governance**: the range aggregates load only the columns they roll up (tool-call inputs and
  outputs, run error text and prompt hashes no longer cross the wire), and the Telescope panels of one
  dashboard load share each `spendByModel` / `spendByActor` / `runMetrics` read.
