---
'@dudousxd/nestjs-agent-core': patch
'@dudousxd/nestjs-agent-store-drizzle': patch
'@dudousxd/nestjs-agent-testing': patch
'@dudousxd/nestjs-agent-dashboard': patch
---

An independent proposal's tool-call record follows the proposal. In `actionApprovalMode: 'independent'` the turn records the call as `proposed` and ends; approving, executing, rejecting, expiring or superseding the proposal only changed the proposal row, so the dashboard (and anything reading `agent_tool_call`) showed an executed action as PROPOSED forever. Every store (in-memory, MikroORM, Drizzle) now settles the call on each proposal transition, in the same write path: `executed` with the output, `failed` with the error, `rejected`, or `expired` (lapsed, or superseded by a newer proposal). New in core: `toolCallUpdateForProposal` / `toolCallUpdateForTransition`; in testing: `PROPOSED_TOOL_CALL_CONTRACT`. The Drizzle read-model accepts the `proposed` status filter, and the dashboard shows `proposed` as live.
