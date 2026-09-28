---
'@dudousxd/nestjs-agent-mcp': minor
---

`McpServerConfig.screen` (and a module-wide `AgentMcpModuleOptions.screen`): inspect every listed tool definition before it is imported, and skip the ones it refuses — the seam for tool-poisoning checks such as `createGuardrails({ toolPoisoning: true }).screenTool`. A screen that throws skips the tool too.
