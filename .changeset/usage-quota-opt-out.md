---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
'@dudousxd/nestjs-agent-testing': minor
'@dudousxd/nestjs-agent-store-drizzle': minor
'@dudousxd/nestjs-agent-store-mikro-orm': minor
---

`recordUsage` for spend the app budgets on its own, and a sharper usage breakdown (paired with `@adonis-agora/agent`).

- `countsTowardsQuota: false` on `AgentService.recordUsage` (and `RecordUsageInput`) keeps a row out of the agent's quota: `quotaToday` / `usageBetween` / `usageWindows` skip it and no `QuotaStore` counter is bumped. It stays in the ledger, every report and `usage.recorded` (which carries `countsTowardsQuota: false`). Stored in the new `agent_token_usage.counts_towards_quota` (boolean, `NOT NULL DEFAULT true`), added by the Drizzle heal and the MikroORM heal (schema revision 6).
- `modelId` is optional on `recordUsage`: absent, `null` or blank → `'unknown'` (`UNKNOWN_MODEL`).
- `usageBreakdown` takes a timestamp window (`{ from, to }`, `to` exclusive, `usageRangeBounds`) as well as UTC days, reports `unpricedRows`, and `reprice: false` reports recorded cost only.
- Testing: three more `USAGE_LEDGER_STORE_CONTRACT` cases.
