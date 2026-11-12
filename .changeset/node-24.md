---
"@dudousxd/nestjs-agent-ai-sdk": minor
"@dudousxd/nestjs-agent-channels": major
"@dudousxd/nestjs-agent-codegen": minor
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent-dashboard": minor
"@dudousxd/nestjs-agent-data": minor
"@dudousxd/nestjs-agent-evals": minor
"@dudousxd/nestjs-agent-mcp": minor
"@dudousxd/nestjs-agent-mcp-server": minor
"@dudousxd/nestjs-agent": major
"@dudousxd/nestjs-agent-opencode": major
"@dudousxd/nestjs-agent-poppy": major
"@dudousxd/nestjs-agent-rag-media": minor
"@dudousxd/nestjs-agent-rag": minor
"@dudousxd/nestjs-agent-react": minor
"@dudousxd/nestjs-agent-store-drizzle": minor
"@dudousxd/nestjs-agent-store-mikro-orm": minor
"@dudousxd/nestjs-agent-telescope": minor
"@dudousxd/nestjs-agent-testing": minor
"@dudousxd/nestjs-agent-transport-redis": minor
---

Require Node.js 24 or newer: `engines.node` is now `>=24` (was `>=20`, `>=22`, or unset). CI tests on Node 24 and 26. Upgrade Node, then the packages.

Removed, with no alias (see the docs' Upgrading page):

- `@dudousxd/nestjs-agent-core`: `AGENT_QUOTA_STORE` (nothing has bound it since the quota rework; use `AGENT_QUOTA_PROVIDER`), `announcedPoppyIssuer` (use `globalPoppyIssuer`, the same function), and `assertNoLegacyKitOptions` with the migration errors `genuiSandboxKit()`, `writeSandboxKitDocs()` and `defineSandbox()` threw for options removed in 0.53.
- `@dudousxd/nestjs-agent`: `AgentService.renameThread()`. Use `updateThread(actor, threadId, { title })`.
- `@dudousxd/nestjs-agent-mcp-server`: the `announcedPoppyIssuer` re-export. It now re-exports `globalPoppyIssuer`.
- `@dudousxd/nestjs-agent-telescope`: `agentToolsProvider()`, the ephemeral `agent.tools` table the extension no longer registered. Use `agentRecentToolCallsTableProvider()`.
