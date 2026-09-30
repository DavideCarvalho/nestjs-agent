---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-react": minor
"@dudousxd/nestjs-agent-testing": minor
"@dudousxd/nestjs-agent-store-drizzle": minor
"@dudousxd/nestjs-agent-store-mikro-orm": minor
"@dudousxd/nestjs-agent-codegen": minor
---

Send while the agent is still answering: the message queue.

- **Server.** `POST <base>/chat` on a thread with a turn running queues the message on the thread (persisted, per-thread FIFO) and answers `202 { queued: true, messageId, position, queue }` instead of starting a second, concurrent turn. When the turn settles the next queued message starts under its own id (inline and durable runners — the durable drain is journaled and spawned with `ctx.startChild`, so it never starts twice), announced as a final `queue` frame (`started: { messageId, runId }`) before the terminal. `mode: 'interrupt'` cancels the running turn and runs the message next; `mode: 'queue'` always queues. A failed turn or a Stop pauses the queue; an exhausted quota pauses it as the next message starts. New routes: `GET`/`DELETE threads/:id/queue`, `POST threads/:id/queue/resume`, `PATCH`/`DELETE queue/:messageId`; `GET threads/:id` carries `queue`. Admission is now a compare-and-set on the thread's active run (one turn per thread across pods; a stale holder left by a crashed process is replaced). `AgentService.send()` queues; `AgentService.chat()` stays start-or-refuse for in-process callers (`409 run_active` on a busy thread); `regenerate` on a busy thread is `409`.
- **Core.** `ChatQueueStore` (probed by `isChatQueueStore`), `QueuedMessage`/`ChatQueueState`/`QueuePause`, the `queue` stream event, `ThreadDetail.queue`, `AgentRunner.start(input, { runId })` and the optional `isRunActive`. `InMemoryAgentStore` implements the queue.
- **Stores.** Drizzle and MikroORM add `agent_queued_message` and `agent_thread.queue_pause` on boot (MikroORM: in `agentManagedTables()`); both implement `ChatQueueStore`.
- **Testing.** `CHAT_QUEUE_STORE_CONTRACT` — framework-agnostic cases any `ChatQueueStore` can run.
- **React.** `composer.submit()` / `sendMessage` mid-turn queue instead of being refused; `useAgentChat({ whileRunning: 'queue' | 'interrupt' | 'block' })`; `chat.queue` (`items`, `paused`, `add`, `remove`, `edit`, `move`, `clear`, `resume`, `error`); `chat.transcript.queued` renders waiting messages as pending user messages; the chat attaches to a queued turn when it starts, and starts a queue left waiting when the thread loads. `AgentBackend` gains the optional `enqueueMessage`, `getQueue`, `updateQueuedMessage`, `removeQueuedMessage`, `clearQueue`, `resumeQueue`; a `202` from `openChatStream` is reported as `queued`.
- **Codegen.** The five queue routes, and `queue` on the thread detail.
