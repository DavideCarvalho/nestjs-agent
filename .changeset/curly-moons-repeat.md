---
'@dudousxd/nestjs-agent-store-mikro-orm': minor
---

Ship a custom `EntityRepository` per agent entity — `AgentThreadRepository`, `AgentMessageRepository`, `AgentToolCallRepository`, `AgentTokenUsageRepository`, `AgentModelPricingRepository`, `AgentRunRepository` and `RagIngestionLogRepository`.

Each is wired into its `EntitySchema` and declared on the entity class via `[EntityRepositoryType]`, so a host app can resolve one by type — `em.getRepository(RagIngestionLog)` or `@InjectRepository(RagIngestionLog)` in a Nest provider — instead of passing the entity class to every `em.find(RagIngestionLog, …)` call. The generated schema is unchanged: the boot fingerprint in `ensureAgentSchema` hashes tables, columns, indexes and collation only, so no host re-heals.
