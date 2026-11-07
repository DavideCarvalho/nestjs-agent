---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-dashboard": minor
"@dudousxd/nestjs-agent-channels": minor
"@dudousxd/nestjs-agent-poppy": minor
"@dudousxd/nestjs-agent-mcp-server": minor
---

`decorators: ClassDecorator[]` on every module that mounts controllers — `AgentModule` (its routes, the protocol adapters' and the engine's), `AgentDashboardModule`, `AgentChannelsModule`, `AgentPoppyConnectionsModule`, `AgentMediaAttachmentsModule` and `AgentMcpServerModule` (added after the agent's own guard and filter) — the ecosystem's convention, like `@nestjs/mcp`'s: decide who reaches the routes with the official tools, e.g. `[UseGuards(AuthenticationGuard), Can(AgentPolicy, 'chat')]`. They are applied to a subclass of each controller made for that registration (`withControllerDecorators` in core), so nothing sticks to the shared classes or leaks into another registration. Without them the routes stay open to `@nestjs/authorization`'s deny-by-default guard (`CanAnyone()`), and a `@Can()` passed here is still checked.
