---
"@dudousxd/nestjs-agent-core": patch
"@dudousxd/nestjs-agent-mcp": patch
---

`Guardrails.screenTool` is now bound to its instance, so `screen: guardrails.screenTool` works as the `McpToolScreen` docs describe. Passed detached before, it threw on `this`.
