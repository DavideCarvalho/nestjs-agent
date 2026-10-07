---
"@dudousxd/nestjs-agent": patch
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent-dashboard": patch
---

`aviary:agent:quota.exceeded` is now published when the send gate refuses a turn with `429`, and when the message queue pauses on quota. Before, only the loop's legacy `deps.quota` path published it, and `AgentModule` never sets that path, so the dashboard and Telescope never saw a quota refusal.

`AgentQuotaExceeded` now has optional `period`, `reason`, `usedUsd` and `limitUsd`. `usedTokens` and `limitTokens` are now optional, because a USD-only spend cap has no token figures. The dashboard's live feed shows a USD ceiling when the window has no token ceiling. Also fixed the `QuotaProvider` JSDoc: the option is `AgentModule.forRoot({ quota })`, not `quotaProvider`.
