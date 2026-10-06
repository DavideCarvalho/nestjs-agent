---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-testing": minor
"@dudousxd/nestjs-agent-store-drizzle": minor
"@dudousxd/nestjs-agent-store-mikro-orm": minor
"@dudousxd/nestjs-agent-opencode": minor
---

`hostContext`: the host's own JSON facts about a send (where it came from, where its answer goes) travel on `AgentRunInput` through `AgentService.chat`, the queue (persisted by the in-memory, Drizzle and MikroORM stores; never on the wire view) and the durable journal. The OpenCode engine's host gets lifecycle hooks: `onAsk`, `onUi`, `beforeSettle` (append components, word a failure) and `onSettled` (deliver, record spend), each seeing the run's `hostContext`.
