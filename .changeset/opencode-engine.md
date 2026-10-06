---
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-opencode": minor
"@dudousxd/nestjs-agent-mcp-server": minor
---

Engines: `AgentModule.forRoot({ engine })` runs turns on something other than the library's loop, and `@dudousxd/nestjs-agent-opencode`'s `openCode({ host })` runs them on OpenCode 2 sessions — the library's routes, stream protocol, approvals, questions and queue over OpenCode's loop. `model` is optional when an engine is set. Durable turns via `openCodeDurable()` (`/durable`); approval policy, `@AiTool`s over MCP, skills, memory and regenerate reach the OpenCode session. `AgentMcpServerModule`'s `context` option ties a tool call to the conversation it serves (from `_meta`); under OpenCode, tools' `ctx.emitUi` reaches the turn, `remember` writes memory, and `keyValueOpenCodeSessionStore` shares sessions across processes.
