---
"@dudousxd/nestjs-agent-store-mikro-orm": minor
---

Implements the (optional) `AgentStore.updateThread` and `AgentStore.activeRunForThread` SPI methods.
`updateThread` patches `title`/`defaultAgent` — each field only touched when present in the patch, so
a title-only update never has to know the current `defaultAgent` to preserve it; `defaultAgent` is a
new additive, nullable column on `agent_thread`, healed in via the existing fingerprint-gated
`ensureAgentSchema` (no migration). `activeRunForThread` reads the same `activeStreamId` field
`setActiveStream` already writes — the reverse lookup, keyed by threadId, that lets a client
reconnecting after a refresh discover a run to reattach to.

Exports `agentManagedTables()` — the five agent table names, derived from the store's existing
internal set (never a hand-maintained parallel list) — for a host's own MikroORM schema-diff
`skipTables`, mirroring `durableManagedTables()` / `telescopeManagedTables()` in the sibling
`@dudousxd/nestjs-durable` / `-telescope` ecosystem.
