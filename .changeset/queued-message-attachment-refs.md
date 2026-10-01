---
'@dudousxd/nestjs-agent-core': patch
'@dudousxd/nestjs-agent-store-drizzle': patch
'@dudousxd/nestjs-agent-store-mikro-orm': patch
---

`referencedMediaIds` (and so `AgentService.collectableAttachments` and the media-backed
"referenced by one of your messages" access fallback) now counts a message WAITING IN A THREAD'S
QUEUE as a reference to its attachments, on the in-memory, Drizzle and MikroORM stores. Before, a
sweep could collect the files of a queued (or paused-queue) message before it ran, failing the turn
it was waiting to start. Removing the queued message, or editing its attachments away, frees them
again. No schema change: it reads `agent_queued_message.attachments`. Parity with
`@adonis-agora/agent` 0.58.
