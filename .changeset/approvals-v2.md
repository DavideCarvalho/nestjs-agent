---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
'@dudousxd/nestjs-agent-react': minor
'@dudousxd/nestjs-agent-store-drizzle': minor
'@dudousxd/nestjs-agent-store-mikro-orm': minor
'@dudousxd/nestjs-agent-testing': minor
---

Approvals v2: who approves an action, for how long, and whether to ask again.

- core: `ApprovalPolicy` SPI (`requirementFor(tool, actor, thread) → { required, approver, ttlMs? }`,
  optional `canDecide`), default = the requester with no expiry. Decided inside the call's
  `persist:toolcall` checkpoint together with the thread's remembered approvals, so replays read it
  back. `AgentLoopHooks.awaitApproval` gains `{ timeoutMs }`; a lapsed wait (`Decision.expired`)
  settles the call as the new `ToolCallStatus 'expired'`, told to the model as an expired approval.
  `Decision.remember` / `Decision.decidedVia`; new `approval-settled` stream frame;
  `StoredMessage.approvals`; optional store methods `rememberedApprovals` / `toolCallApproval`.
- nestjs: `forRoot({ approvalPolicy })`; approve/reject enforce the recorded approver (403) and
  refuse a lapsed request (410), record the decider and `via`, accept `remember`. The durable runner
  passes the ttl to `ctx.waitForSignal(…, { timeoutMs })`, the inline runner arms a timer.
- stores: `agent_tool_call` gains `approver`, `expires_at`, `remember`, `decided_via` (added by
  `ensureAgentSchema`), read back as `StoredMessage.approvals`.
- react: `call.approval` gains `status`, `remember`, `decidedBy`, `decidedVia`, `decisionReason`;
  `call.approve.run({ remember: true })`; headless `useApprovalCountdown(expiresAt)`;
  `data-approval-settled` parts live and on reload.
