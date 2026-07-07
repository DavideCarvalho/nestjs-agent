---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-testing": minor
"@dudousxd/nestjs-agent-store-mikro-orm": minor
"@dudousxd/nestjs-agent-store-drizzle": minor
---

Scope `cancel` to the run owner, and ship a pricing write API.

- **Cancel ownership.** `POST /agent/chat/:runId/cancel` (and `AgentService.cancel`) now resolve the acting actor and assert they own the run being aborted — the last governance endpoint that acted on a raw id. Backed by a new `AgentStore.ownerOfActiveStream(runId)` SPI method (the thread whose `activeStreamId` is the run), implemented by the bundled MikroORM, Drizzle, and in-memory stores.
- **Pricing write API.** A new `AgentPricingStore` SPI — `upsertModelPrice` (atomic supersede of the model's current row) and `listCurrentPrices` — plus the `seedModelPrices` helper and the `AGENT_PRICING_STORE` token. Implemented on all three stores and bound globally by the store modules. Cost was $0 out of the box because pricing rows had no writer; seed your models' per-1M rates once and the read-model prices against them.
- **Breaking (SPI):** `AgentStore` gains `ownerOfActiveStream`; custom store adapters must implement it.
