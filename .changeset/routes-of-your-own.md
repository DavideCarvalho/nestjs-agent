---
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-dashboard": minor
"@dudousxd/nestjs-agent-mcp-server": minor
---

Mount the agent's routes yourself, as NestJS's own packages let you. `AgentModule.forRoot({ routes: false })` and `AgentDashboardModule.forRoot({ routes: false })` mount no controllers while everything else runs, and the controllers are exported to extend under your own path and decorators (`ChatController`, `ThreadsController`, `ToolCallController`, `QuotaController` and `AgentsController` are now exported too). `AgentMcpServerModule.forRoot({ path: false })` mounts no endpoint: serve `@nestjs/mcp`'s `McpHttpService` from a controller of your own behind `AgentMcpAuthGuard` and `McpChallengeFilter`, which whoever imports the module can now use. The docs recommend, in order: mounting the routes yourself and protecting them with `@nestjs/authentication` / `@nestjs/authorization`, then `decorators`, with `guards` kept for compatibility.
