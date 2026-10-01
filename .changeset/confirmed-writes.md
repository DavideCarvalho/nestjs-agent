---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent-testing": minor
"@dudousxd/nestjs-agent-ai-sdk": minor
"@dudousxd/nestjs-agent-mcp-server": minor
"@dudousxd/nestjs-agent-store-drizzle": minor
"@dudousxd/nestjs-agent-store-mikro-orm": minor
---

Confirmed writes — preview, signed single-use `confirmToken`, commit (port of adonis-agora-agent#233).

`defineConfirmedTool(options, { prepare, preview, commit })` returns a functional tool whose human gate lives inside it, so the same write serves the chat loop and MCP (where an `action` tool has no approval channel): a call without `confirm` validates and previews without writing and returns a `confirmToken`; the same arguments plus `confirm: true` and the token commit. The token is an HMAC over the tool, actor, tenant, expiry and canonical arguments. A `ConfirmTokenStore` makes it single use — claimed right before `commit`, released if `commit` throws.

- core: `defineConfirmedTool`, `withConfirmFields`, `ConfirmTokenError`, `signConfirmToken` / `verifyConfirmToken` / `hashConfirmToken` / `canonicalJson`, the `ConfirmTokenStore` SPI, `InMemoryConfirmTokenStore`, `AGENT_CONFIRM_TOKEN_STORE`, and `SchemaExtension` / `schemaExtensionOf` (a schema that is another schema plus a few JSON properties).
- ai-sdk, mcp-server: a `SchemaExtension` schema is converted through its inner schema, so a Zod 3 tool wrapped by `withConfirmFields` shows the model its real shape plus `confirm` / `confirmToken`.
- store-drizzle, store-mikro-orm: `DrizzleConfirmTokenStore` / `MikroOrmConfirmTokenStore` on a new `agent_confirm_token` table (created by `ensureAgentSchema`; MikroORM: also in `agentEntities()` / `agentManagedTables()`), bound to `AGENT_CONFIRM_TOKEN_STORE` by the store modules.
- testing: `CONFIRM_TOKEN_STORE_CONTRACT`, the cases every store runs.
