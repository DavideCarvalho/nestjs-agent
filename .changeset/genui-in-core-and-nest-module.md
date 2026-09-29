---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-react": minor
"@dudousxd/nestjs-agent-mcp-server": patch
---

Generative UI, reworked around the three packages apps already use.

- **core**: the catalog moves to `@dudousxd/nestjs-agent-core/genui` (+ `/genui/builtins`), an isomorphic entry a browser can import (it bundles nothing server-only). `genuiTools` gains `resolveCatalog` (a per-request catalog consulted on every call and every turn's description) and `showTool` (one generic `ui__show` taking `{ component, props }`, for components no boot-time tool can name). `AiToolCtx.emitUi` is now always present — `createNoopEmitUi()` where there is no conversation — so tools call `ctx.emitUi(…)` without `?.`; genui tools no longer fall back to returning props. New `ToolHandler.describe(scope)` lets a tool vary its model-facing description/schema per turn; `definitionsFor` takes an optional `{ threadId, agentName }` scope and `LlmStepEnvelope` carries `threadId`.
- **nestjs**: `@dudousxd/nestjs-agent/genui` — `AgentGenuiModule.forRoot({ catalog, mode, terminal, treeToolName, treeInstructions, roles, presentation, showTool, resolver })` / `forRootAsync({ imports, inject, useFactory, resolver })` registers the genui tools as agent tools; `GENUI_CATALOG` + `@InjectGenuiCatalog()`; `GenuiCatalogResolver` for per-tenant, versioned catalogs; `provideAgentTools` registers a factory-produced list of tools.
- **react**: `<GenuiProvider registry catalog resolveComponent fallback treeRenderer>` at the root; `<GenerativeUI part />` and `useGenerativeUI(part)` read it (own props win), and `MessageItem` draws pushed components with no `renderUi` inside one. json-render is an option — `GenuiProvider` from `/genui/json-render` takes `jsonRender` (a json-render registry, or `true` to derive one) — instead of a `genui:tree` registry entry.
- **mcp-server**: tools get a no-op `ctx.emitUi`.

The never-published `@dudousxd/nestjs-agent-genui` package is gone; import from `@dudousxd/nestjs-agent-core/genui`.
