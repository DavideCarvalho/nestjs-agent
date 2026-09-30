---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-react": minor
"@dudousxd/nestjs-agent-testing": minor
"@dudousxd/nestjs-agent-codegen": minor
"@dudousxd/nestjs-agent-store-drizzle": patch
"@dudousxd/nestjs-agent-store-mikro-orm": patch
---

Message queue: a per-call mode, interrupting with a message that is already waiting, and queued
files in the shape sent files have.

- **`composer.submit({ mode })` / `sendMessage(message, { mode })`** (react) — `'queue'` or
  `'interrupt'` for that one send, overriding the chat's `whileRunning` (`'block'` included). What a
  "send now" button next to a plain send needs; the composer clears its own draft and files, so a
  host no longer calls `chat.queue.add` and resets the draft by hand. With nothing running, `mode`
  means nothing and the message is simply sent (it never reaches the request).
- **`chat.queue.interrupt(id)`** (react) and **`POST <base>/queue/:messageId/interrupt`** (nestjs,
  `AgentService.interruptQueuedMessage`, `AgentBackend.interruptQueuedMessage?`,
  `AgentClient.interruptQueuedMessage`, codegen `queue.interrupt`) — run a waiting message now: it
  moves to the head marked as an interrupt, any pause is lifted, and the running turn is cancelled
  for it, in one request. It answers the queue plus `interrupting` (the cancelled run), or `runId`
  when nothing was running and the message started. The message keeps its id and never leaves the
  queue — a `remove` followed by an `add` loses it when the second call fails and runs it twice when
  another tab's drain gets there first. Documented in docs/stream-protocol.md (*Interrupting with a
  message that is already waiting*); optional for a backend of your own.
- **`QueuedMessagePatch.interrupt`** (core) — `ChatQueueStore.updateQueuedMessage` may now mark or
  unmark a waiting message as an interrupt. `InMemoryAgentStore`, the Drizzle store and the MikroORM
  store store it (the column already existed), and `CHAT_QUEUE_STORE_CONTRACT` has a case for it. A
  store of your own that ignores the key keeps working for everything else; the new route answers
  `501` on it rather than cancel a turn for a message that would then not start.
- **`TranscriptQueuedItem.files` / `QueuedChatMessage.files`** (react) — a waiting message's files
  are `MessageFile`s (`kind`, `extension`, `mediaId`, as `messageFiles()` gives for a sent message);
  the transcript's also keep `isImage`, so both the `MessageFile` and the `TranscriptFile` renderer
  take them. New export `attachmentFile(attachment)`. Type note: `QueuedChatMessage.files` and
  `ChatQueue.interrupt` are required members — code that builds those objects by hand (a test
  double, mostly) adds them; `useChatTranscript({ queue })` still takes items without `files`.
