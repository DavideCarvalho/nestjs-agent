---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-store-mikro-orm": minor
"@dudousxd/nestjs-agent-store-drizzle": minor
"@dudousxd/nestjs-agent-ai-sdk": minor
"@dudousxd/nestjs-agent-data": patch
---

Pre-1.0 API simplifications from the docs review:

- **`AiToolCtx` identity is `ctx.actor` only** (breaking): dropped the denormalized `ctx.actorId` / `ctx.tenantRef` — read `ctx.actor.id` / `ctx.actor.tenantRef`.
- **`AgentModule.forRoot({ store })` is now optional**: omit it and the agent resolves `AGENT_STORE` from a store module. Store modules (`MikroOrmAgentStoreModule` / `DrizzleAgentStoreModule`) now bind `AGENT_STORE` + `AGENT_GOVERNANCE_QUERIES` **globally**, so the dashboard/telescope surfaces resolve the read-model with no host re-binding.
- **Declarative functional tools**: `provideAgentTool(factory, inject?)` (or a static `{ spec, handler }`) plus `forRoot({ tools })` register a functional tool with full DI — no more injecting `AGENT_TOOL_REGISTRY` and calling `.register()` in a lifecycle hook.
- **`agentDurable(options)`** from `@dudousxd/nestjs-agent/durable` composes `AgentModule.forRoot({ durable: true })` + `AgentDurableModule` in one import (the `durable: true` + separate module path still works).
- **New `@dudousxd/nestjs-agent-ai-sdk`**: `aiSdkModel(model, opts?)` adapts a Vercel AI SDK v6 `LanguageModel` to the `ModelProvider` SPI — streaming, tool-call translation, usage (incl. cache/reasoning), and gateway `costUsd` — so most apps write zero provider code. The first of a family of provider adapters.
