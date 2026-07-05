---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent-testing": minor
"@dudousxd/nestjs-agent-store-mikro-orm": minor
"@dudousxd/nestjs-agent-store-drizzle": minor
---

Accurate cost accounting: prefer a provider-reported cost, and make the fallback estimate cache-aware.

- **Provider-reported cost wins.** `ModelTurnResult.costUsd` carries the real spend a gateway reports (Vercel AI Gateway `providerMetadata.gateway.cost`, OpenRouter `total_cost`); the loop persists it to the nullable `agent_token_usage.cost_usd` column and the read-model resolves cost per row as `COALESCE(reportedCostUsd, tokens × pricing)`. Direct providers (Anthropic/OpenAI/Bedrock) report only tokens and fall through to the estimate.
- **Cache-aware fallback.** `MessageUsage` gains `cacheWriteTokens` / `cacheReadTokens` (subsets of `inputTokens`) and `reasoningTokens` (a subset of `outputTokens`, observability only). `AgentModelPricing` gains nullable `cacheWritePricePer1m` / `cacheReadPricePer1m`; the estimate prices the uncached remainder at the input rate, cache-write/read at their own rates, output at the output rate — and falls back to the input rate for cache tokens when a pricing row has no cache rates.

Because the cache counts are subsets of `inputTokens`, token totals and quota are unchanged, and a pricing table with no cache data reduces exactly to the previous `input×inputPrice + output×outputPrice`. Both changes are backward compatible (nullable columns; optional fields).
