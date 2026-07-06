# API simplification (pre-1.0)

**Status:** in progress 2026-07-06. Six simplifications agreed with Davi from the docs review. Pre-1.0, so breaking changes are fine (nothing on npm yet). Core changes land first (done); the rest fan out per-package.

## Contracts (single source of truth for the parallel work)

### #1 — `AiToolCtx` loses `actorId` / `tenantRef` (DONE in core)
Identity is `ctx.actor` only. `ctx.actorId` → `ctx.actor.id`; `ctx.tenantRef` → `ctx.actor.tenantRef`. Type in `core/src/spi/tool.ts` + construction in `core/src/agent-loop.ts` already updated. Consumers to fix: `data/src/execute-sql.tool.ts` (`ctx.tenantRef`), `examples/agent-demo/src/tools/*.tool.ts` (`ctx.actorId`), and any spec.

### #2 — `store` optional on `AgentModule.forRoot`
`AgentModuleOptions.store?: AgentStore` (was required). In `agent.module.ts`, provide `AGENT_STORE` from `options.store` **only when defined**; when omitted, do not provide it in AgentModule scope so a globally-bound `AGENT_STORE` (from a store module, see #4) satisfies the dependency. Clean path becomes: import the store module, don't pass `store`.

### #3 — declarative functional tools (kills `.register`)
Functional tools (`{ spec: ToolSpec; handler: ToolHandler }`, e.g. from `createExecuteSqlTool`) get the same auto-registration as `@AiTool` classes. Two front doors, both in the **nestjs** package:

- `provideAgentTool(factory: (...deps) => FunctionalTool, inject?: unknown[]): Provider` — a Nest provider whose resolved instance is a **branded** `{ [AGENT_TOOL_BRAND]: true, spec, handler }`. Also accepts a static tool: `provideAgentTool(tool: FunctionalTool)`. Uses a fresh `Symbol()` provide token per call (unique) + `useFactory`/`useValue` with `inject`.
- `AgentModule.forRoot({ tools?: FunctionalTool[] })` — static functional tools, registered directly.

`AiToolDiscoveryService` already walks every provider app-wide via `DiscoveryService`; extend it to also register any provider instance carrying `AGENT_TOOL_BRAND`, plus `options.tools`. `AGENT_TOOL_BRAND = Symbol.for('@dudousxd/nestjs-agent:functional-tool')` (declare in nestjs). No core change. `AGENT_TOOL_REGISTRY` stays internal — it disappears from user-facing docs.

`FunctionalTool` type: `{ spec: ToolSpec; handler: ToolHandler }` (import `ToolSpec`/`ToolHandler` from core).

### #4 — store modules bind their tokens globally
`MikroOrmAgentStoreModule.forFeature()` and `DrizzleAgentStoreModule.forRoot()` return `{ ..., global: true }` so `AGENT_STORE` + `AGENT_GOVERNANCE_QUERIES` are app-wide. This is what lets #2 work and lets the dashboard/telescope surfaces resolve `AGENT_GOVERNANCE_QUERIES` without the host re-binding it. (The in-memory testing store stays as-is; demo binds it explicitly.)

### #5 — `agentDurable(options)` helper (durable subpath)
Export `agentDurable(options: AgentModuleOptions & DurableBits): DynamicModule[]` from `@dudousxd/nestjs-agent/durable` returning `[AgentModule.forRoot({ ...options, durable: true }), AgentDurableModule.forRoot(durableBits)]`. One import from the durable subpath instead of two; peer dep stays opt-in (lives in the durable entrypoint). Keep the existing `durable: true` + separate `AgentDurableModule` path working.

### #6 — `@dudousxd/nestjs-agent-ai-sdk` (new package, family of adapters)
`aiSdkModel(model, opts?): ModelProvider` maps the Vercel AI SDK v6 `streamText` to the `ModelProvider` SPI so users write zero provider code. Designed as the first of a family (`-tanstack-ai`, …) — core `ModelProvider` stays the single seam; each adapter is an isolated package returning a `ModelProvider`.

**SPI to implement (from core):**
- `runTurn({ system, messages, tools, sink, abortSignal }) => Promise<ModelTurnResult>`
- `ModelTurnResult = { text; toolCalls: ToolCallRequest[]; usage: MessageUsage; modelId?; costUsd? }`
- `ModelMessage = { role: 'user'|'assistant'|'system'; content: string; toolCalls?; toolResults? }`
- `ToolDefinition = { name; kind; description; inputSchema: StandardSchemaV1 }`
- `ToolCallRequest = { id; name; input: unknown }`
- `MessageUsage = { inputTokens; outputTokens; cacheWriteTokens?; cacheReadTokens?; reasoningTokens? }`

**Mapping:** stream `fullStream` text deltas → `sink.write`; pass tools to the SDK **without** an `execute` fn (so tool-calls come back rather than run); assemble text + tool-calls (→ `ToolCallRequest`); map SDK usage → `MessageUsage` (incl. cache/reasoning when present); pull `modelId` from the response; pull `costUsd` from `providerMetadata` (`gateway.cost` / OpenRouter `total_cost`). Convert `StandardSchemaV1` → the SDK's tool schema. Pin `ai` as a `^6.0.0` peer dep (match `-react`).
