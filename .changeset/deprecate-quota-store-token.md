---
"@dudousxd/nestjs-agent-core": patch
---

`AGENT_QUOTA_STORE` is deprecated. Nothing has bound or injected it since the quota rework: `AgentModule` enforces and reports the budget through `AGENT_QUOTA_PROVIDER`, configured with `AgentModule.forRoot({ quota })`. Inject `AGENT_QUOTA_PROVIDER` instead. The token will be removed in the next major.
