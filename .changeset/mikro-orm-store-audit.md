---
"@dudousxd/nestjs-agent-store-mikro-orm": patch
---

- `MikroOrmAgentStore` now declares `ActionProposalOutcomeStore` and `ActionProposalSupersessionStore` in its `implements` clause. It already had the methods.
- The MySQL schema lock now waits up to 30s (`get_lock(..., 30)`), the same as the Drizzle adapter. It was 10s.
- Docs: the `AGENT_ENTITIES` comment, the module JSDoc and the README no longer claim that `forFeature()` registers the entities. The host adds them to its MikroORM config. The README's sections that came after "License" now sit before it.
