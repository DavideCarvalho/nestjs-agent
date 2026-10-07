---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-react": patch
"@dudousxd/nestjs-agent-codegen": patch
---

**Security:** proposal routes no longer return raw store rows. `GET /threads/:threadId/action-proposals`, the approve/reject routes, text decisions, the AG-UI decision event and the approval port all returned the stored row. That row includes the worker's execution lease token (which lets its holder settle the work), the delivery lease, the tool's `idempotencyKey`, and the execution address (`preparationInput`, `executionContext`). They now return `ActionProposalView` / `ActionProposalMutationView` (new in core, built with `toActionProposalView` / `toActionProposalMutationView`), which leave all of those out. `AgentApprovalPort`'s proposal methods and the React client's proposal types now use the view types. The codegen mirror no longer declares `idempotencyKey`.
