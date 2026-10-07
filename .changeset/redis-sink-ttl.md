---
"@dudousxd/nestjs-agent-transport-redis": minor
"@dudousxd/nestjs-agent": patch
---

Redis stream keys now expire.

- `@dudousxd/nestjs-agent-transport-redis`: `RedisTokenStreamSink` takes a `ttlSeconds` option (default 3600; `0` keeps keys until `close()`). Nothing calls `close()` on its own, so before this, every run's `:chunks` and `:state` keys stayed in Redis forever. The TTL slides from the run's last write and is set on both keys when the run ends or fails. `RedisStreamClient` gains an `expire(key, seconds)` method. An adapter that doesn't implement it still streams, but its keys never expire.
- `@dudousxd/nestjs-agent/sink-redis`: the TTL is now also re-armed on every write, so a run that crashes without ending still expires. `ttlSeconds: 0` now means "keep until `close()`". Before, it sent `EXPIRE 0`, which deleted the stream when the run ended.
