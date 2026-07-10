---
"@dudousxd/nestjs-agent-react": patch
---

Fix a threadless chat spawning a new thread on every message. `useAgentChat` captured the
backend-created thread id from the `meta` frame only into `runId` — so the next send still carried
no `threadId` and the backend minted another thread. It now remembers the created id and reuses it
on subsequent sends, and exposes an `onThreadCreated(threadId)` callback so the consumer can sync its
URL/router to the newly created thread (title, sidebar, and reload then bind to it).
