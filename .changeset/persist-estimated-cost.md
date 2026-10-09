---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-store-drizzle": minor
"@dudousxd/nestjs-agent-store-mikro-orm": minor
"@dudousxd/nestjs-agent-opencode": patch
---

The estimated cost now reaches the usage ledger, and the quota counts it.

For a provider that reports no cost (Bedrock, or OpenAI and Anthropic called directly), the loop's estimate (tokens times the price row) reached only the stream frame and `agent_message.usage.costUsd`. `agent_token_usage.cost_usd` stayed NULL, so the quota's USD windows read $0.

- **The ledger stores the estimate.** `agent_token_usage.cost_usd` now holds it, marked by the new `cost_source` column (`'provider' | 'estimate'`). The boot schema heal adds the column (Drizzle and MikroORM), so no app migration is needed. A provider-reported cost is unchanged, still wins, and is stamped `'provider'`. An unpriced turn keeps both columns NULL. Chat, structured-output and follow-up usage rows are covered.
- **SPI.** `RecordUsageInput.costSource` and `CostSource` are new. `quotaToday` / `usageBetween` return `UsageTotals` (`{ usedTokens, costUsd, estimatedCostUsd? }`), where `costUsd` includes estimates. `sumUsage` is new.
- **Quota.** The USD windows count estimates by default, because a USD ceiling on a provider that reports no cost would otherwise never block. `quota: { limits, countEstimatedCost: false }` counts provider-reported cost only.
