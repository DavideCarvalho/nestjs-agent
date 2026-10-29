---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
'@dudousxd/nestjs-agent-testing': minor
'@dudousxd/nestjs-agent-store-drizzle': minor
'@dudousxd/nestjs-agent-store-mikro-orm': minor
'@dudousxd/nestjs-agent-dashboard': minor
'@dudousxd/nestjs-agent-telescope': patch
---

One usage ledger for every AI cost, and where a run's time goes (paired with `@adonis-agora/agent`).

- `AgentService.recordUsage(input, { throwOnError? })` records AI spend from outside agent turns (transcription, TTS, batch embeddings, direct SDK calls): `actorRef` (`null` → `PLATFORM_ACTOR_REF`, `'@platform'`), `feature`, `modelId`, `provider`, tokens, `audioSeconds` / `characters` / `requests`, `costUsd` / `costSource`, optional `threadId` / `runId` / `tenantRef` / `metadata`. Never throws unless `throwOnError`; answers `{ recorded }`. Framework-free as `recordAiUsage` / `aiUsageRow` in core.
- `RecordUsageInput.threadId` is optional and gains `runId`, `feature`, `provider`, `tenantRef`, the units and `metadata`; `UsagePurpose` gains `'external'`. Drizzle and MikroORM relax `agent_token_usage.thread_id` at boot (the FK and cascade stay) and add the new columns. Agent-turn rows are labelled `agent:<agent name>`.
- New `aviary:agent:usage.recorded` diagnostic for every ledger row (amounts and attribution, never content); `AGENT_DIAGNOSTIC_EVENTS` has 14 events.
- Governance: `spendByFeature` / `usageBreakdown` (shared `bucketByFeature` / `bucketUsageBreakdown`), `RecentRunRow` timing totals, `GovernanceRunDetail.timings`.
- Run timings on `agent_run` (`queue_ms`, `model_ms`, `tools_ms`, `model_calls`, `tool_calls`, `timings`), from the runtime's run `createdAt`, the `llm.turn` span and the `tool.execution` measurement, journaled with the steps that measured them. `run.finished` / `run.failed` / `run.cancelled` carry `queueMs`, `modelMs`, `toolsMs`, `modelCalls`, `toolCalls`, `stepTimings`; `runEndTimings(error)` hands a failure's to the runner.
- Testing: `USAGE_LEDGER_STORE_CONTRACT`. Dashboard: spend by feature and a "where the time went" run panel.
