---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
'@dudousxd/nestjs-agent-react': minor
'@dudousxd/nestjs-agent-store-drizzle': minor
'@dudousxd/nestjs-agent-store-mikro-orm': minor
'@dudousxd/nestjs-agent-testing': minor
'@dudousxd/nestjs-agent-codegen': minor
---

Quota v2: budget windows, a pluggable QuotaProvider, and a send gate.

- core: `QuotaProvider` SPI (`report({ actor, now? }) → { windows: [{ period: 'day' | 'month', usedTokens, limitTokens?, usedUsd, limitUsd?, resetsAt? }], blocked?: { period, reason? } }`), `AGENT_QUOTA_PROVIDER`, `exhaustedWindow`, `quotaPeriodRange`. Optional `AgentStore.usageBetween(actorRef, fromDay, toDay)`.
- nestjs: `GET quota` answers the report. `LedgerQuotaProvider` (the default) reads the usage ledger — a day window (ceiling from the bound `QuotaStore`), plus a month window when the store has `usageBetween`. `AgentModule.forRoot({ quotaProvider })` binds your own (an AI-gateway budget); `quotaLimits: { day?, month? }` (tokens and/or USD) adds ceilings to the default. Either one turns on the send gate: a `blocked` report refuses `POST chat` with `429 { code: 'quota_exceeded', period, message }` before the turn starts. `GET quota/today` is unchanged.
- stores / testing: `usageBetween` (and `quotaToday` delegates to it).
- react: headless `useQuota({ backend, pollMs? })` (windows, `day`, `month`, `blocked`; re-read after every run a chat on the same backend settles); `AgentBackend.getQuota?` / `AgentClient.getQuota()`; `useAgentChat({ blocked })` refuses `sendMessage`/`regenerate` with `QuotaBlockedError` while a window is exhausted.
- codegen: `GET /agent/quota` as `agent.quota.report`; `GET /agent/quota/today`'s response type now matches what it returns.
