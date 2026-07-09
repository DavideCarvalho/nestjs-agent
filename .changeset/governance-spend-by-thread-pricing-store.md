---
"@dudousxd/nestjs-agent-core": patch
"@dudousxd/nestjs-agent-store-mikro-orm": patch
"@dudousxd/nestjs-agent-store-drizzle": patch
"@dudousxd/nestjs-agent-testing": patch
---

Governance queries: add `spendByThread(range, limit)` (top threads by cost) and
`ActorSpendRow.threadCount`. Cost is now priced through the injected
`AGENT_PRICING_STORE` instead of reading `agent_model_pricing` directly, and both
store modules accept a `pricingStore` option so a host can bind its own pricing
table as the single source of cost truth for every governance surface. Default
behavior (the store's own pricing table) is unchanged.
