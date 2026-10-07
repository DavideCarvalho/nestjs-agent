---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-testing": minor
"@dudousxd/nestjs-agent-store-drizzle": minor
"@dudousxd/nestjs-agent-store-mikro-orm": minor
"@dudousxd/nestjs-agent-opencode": minor
---

`hostContext`: the host's own JSON facts about a send (where it came from, where its answer goes) travel on `AgentRunInput` through `AgentService.chat`, the queue (persisted by the in-memory, Drizzle and MikroORM stores; never on the wire view) and the durable journal. The OpenCode engine's host gets lifecycle hooks: `onAsk`, `onUi`, `beforeSettle` (append components, word a failure) and `onSettled` (deliver, record spend), each seeing the run's `hostContext`. `CreateThreadInput.agentName` lets a store start a thread on the send's agent; `AgentRunner.runIdFor` lets a runner name its runs (the OpenCode engine's `runId` setting); `openCodeDurable({ durable: { start, startError } })` sets each turn's workflow start options (tags, search attributes, concurrency quota) and maps a refused start. The host also gets `promptFor` (what the session is prompted with), `reuse` (keep the thread's session or open a new one) and `beforePrompt` (update the session every turn: model, permissions, tools).
