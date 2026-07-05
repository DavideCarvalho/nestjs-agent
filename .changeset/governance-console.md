---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent-testing": minor
"@dudousxd/nestjs-agent-store-mikro-orm": minor
"@dudousxd/nestjs-agent-store-drizzle": minor
"@dudousxd/nestjs-agent-telescope": minor
"@dudousxd/nestjs-agent-dashboard": minor
---

Governance & observability console — the in-process analog of a hosted AI-gateway dashboard, with governance coupled in (cost per model/actor, usage trend, recent tool calls & threads).

- **core** adds the `AgentGovernanceQueries` read-model SPI (`spendByModel` / `spendByActor` / `usageTrend` / `recentToolCalls` / `recentThreads`) and the `AGENT_GOVERNANCE_QUERIES` token — the read/analytics half of the store SPI, separate from the write path.
- **store-mikro-orm** and **store-drizzle** implement it over `agent_token_usage` ⋈ `agent_model_pricing`, aggregating in-process so day-bucketing stays engine-portable.
- **testing** ships `InMemoryGovernanceQueries` (optional pricing map) for unit tests and the offline demo.
- **telescope** exposes the governance sections fed by the shared read-model.
- **`@dudousxd/nestjs-agent-dashboard`** (new) is a standalone, mountable AI-gateway console — a Vite SPA served by a NestJS controller — that needs no Telescope, wired via `AgentDashboardModule.forRoot({ basePath, apiBasePath })`.
