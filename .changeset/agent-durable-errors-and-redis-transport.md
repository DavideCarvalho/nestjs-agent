---
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-transport-redis": minor
---

Surface durable run failures, and add a multi-replica Redis transport.

- **Durable error surfacing.** A failed durable run (e.g. quota exceeded, which throws before the sink is even opened) previously left the HTTP subscriber hanging on a stream that never ended. The workflow now catches real failures — re-throwing durable suspends / continue-as-new untouched — fails the token sink with a typed terminal so the controller emits an `event: error` frame, and re-throws so the engine still records the run as failed. This brings the durable runner to parity with the inline one.
- **New package `@dudousxd/nestjs-agent-transport-redis`.** A multi-replica `TokenStreamSink` over Redis: chunks buffered in a per-run LIST for replay, a pub/sub channel for live wakeups, and a marker key for the terminal (end / fail, the latter re-raised as `AgentStreamError`). It takes a small injected `RedisStreamClient` adapter — bring your own `ioredis` / `node-redis`, no driver dependency of its own. Wire it via `AgentModule.forRoot({ sink: new RedisTokenStreamSink(client) })`.
- Tightened `AgentModuleAsyncOptions` typing: `imports` / `inject` use Nest's own types instead of `unknown[]` plus casts.
