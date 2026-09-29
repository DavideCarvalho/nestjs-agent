---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
'@dudousxd/nestjs-agent-react': minor
'@dudousxd/nestjs-agent-store-drizzle': minor
'@dudousxd/nestjs-agent-store-mikro-orm': minor
'@dudousxd/nestjs-agent-testing': minor
---

Pluggable chat backend, resumable streams, message feedback and a thread-list hook.

- react: `AgentBackend` — the interface every hook talks to (stream start/resume, cancel, thread CRUD required; fork/promote/truncate, approvals, answers, upload, tools, skills, quota, feedback optional). `AgentClient` implements it (new `openChatStream`, `resumeChatStream`, `setMessageFeedback`); `useAgentChat({ backend })` and `AgentChatTransport({ backend })` accept your own (a generated client, cookie session + CSRF). `useAgentChat` is generic over the backend and returns it as `backend` (and `client`), plus `getThreadId()` and `connection`. A missing optional member throws `AgentBackendUnsupportedError`.
- react: the transport reconnects a dropped, numbered stream from its last frame (`?after=<seq>`) with exponential backoff (`reconnect: { maxAttempts, baseDelayMs, maxDelayMs } | false`); `status` reads `'reconnecting'` meanwhile (`ChatStatus` gains it; the transcript treats it as streaming). A run that ended while away reloads the thread.
- react: headless `useThreads({ backend })` (list, optimistic rename/remove, refreshed when a chat on the same backend creates a thread, settles a run or streams a title) and `useMessageFeedback({ backend, threadId })`. Live messages carry `metadata.runId`; replayed ones `metadata.feedback` (`AgentMessageMetadata`). `useToolCatalog`/`createSkillsSource` accept any backend with `listTools`/`listSkills`.
- nestjs: every event frame carries an SSE `id:` (1-based, stable across attaches); `GET chat/:runId/stream` honours `?after=` and `Last-Event-ID`. New `POST messages/:id/feedback` (`MessagesController`, `AgentService.setMessageFeedback`).
- core: `StoredMessage.feedback`, `MessageFeedback`; optional `AgentStore.threadOfMessage` / `setMessageFeedback`.
- store-drizzle / store-mikro-orm: `agent_message.feedback` (json, nullable; added by `ensureAgentSchema`, not copied on fork). testing: `InMemoryAgentStore` implements both.
