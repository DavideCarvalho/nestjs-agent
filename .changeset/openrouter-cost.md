---
"@dudousxd/nestjs-agent-ai-sdk": minor
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": minor
---

Cost works out of the box for OpenRouter, and an unpriced model can no longer go silently null.

- **OpenRouter cost is read.** `aiSdkModel` read `total_cost`, which `@openrouter/ai-sdk-provider` never emits, so every OpenRouter turn recorded a `null` cost. It now reads `providerMetadata.openrouter.usage.cost` (the real, per-call routed cost), keeping `total_cost` as a fallback.
- **Usage accounting is requested.** `aiSdkModel` / `aiSdkModels` add `providerOptions.openrouter.usage = { include: true }` to OpenRouter calls (your own `openrouter.usage` wins) and warn once per model when an OpenRouter call still returns no cost. `AiSdkModelOptions` gains a typed `providerOptions`.
- **Boot seeds missing prices from models.dev.** New optional `ModelProvider.describeModels()` (implemented by `aiSdkModel` / `aiSdkModels`). On application bootstrap `AgentModule` writes the models.dev list price for any configured model the bound `AGENT_PRICING_STORE` has no row for — never overwriting one — and warns once about a model that would record no cost. New `priceCatalog` option (`{ url, fetch }` or `false`); skipped under `NODE_ENV=test` unless set. Core exports `ensureModelPricing`, `lookupModelsDevPrices`, `modelsDevRefsFor`, `seedPricesFromModelsDev`.
