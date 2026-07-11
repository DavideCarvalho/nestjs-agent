---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
'@dudousxd/nestjs-agent-store-mikro-orm': minor
'@dudousxd/nestjs-agent-store-drizzle': minor
'@dudousxd/nestjs-agent-testing': minor
'@dudousxd/nestjs-agent-dashboard': minor
---

Governance wave — approvals inbox, tool stats, prompt hash:

- **HITL approvals inbox**: new `AGENT_APPROVAL_PORT` SPI (`AgentApprovalPort`) bound by the agent
  runtime — console-side approve/reject routed through the SAME decision path chat approvals use
  (durable signal or inline resolution), WITHOUT re-authorization (the console's own guards front
  it). `Decision` gained optional `executedByRef`; the loop persists the decider on both executed
  and rejected action tools (`decision.executedByRef ?? the run's actor`). Governance read
  `pendingApprovals(limit)` (oldest first, joined to thread/actor). Dashboard: Approvals section
  (pending list, approve/reject with reason, nav badge) + `GET approvals` / `POST
  approvals/:toolCallId`; new `approvalActorRef` dashboard option stamps WHO decided from the live
  request; the API returns 501 (and the SPA renders read-only) when no port is bound.
- **Tool governance**: `toolStats(range)` — per-tool calls/failed/rejected + p95 executionMs —
  and a dashboard Tools section.
- **Prompt hash**: each run records the sha256 of its resolved system prompt (pre-RAG, so it
  identifies the prompt VERSION), surfaced on recent runs in the dashboard — correlate error-rate
  shifts with prompt changes.
