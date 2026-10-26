---
"@dudousxd/nestjs-agent": patch
"@dudousxd/nestjs-agent-transport-redis": patch
---

Redis sink subscribers no longer follow a run that is gone forever.

- `@dudousxd/nestjs-agent-transport-redis`: a `RedisTokenStreamSink` subscriber ends once the run's
  keys are gone — `close()` deleted them (it now publishes a wake-up so caught-up subscribers notice),
  or `ttlSeconds` passed with nothing written, after which the keys have expired. A run that writes
  again within its TTL is still followed, and chunks whose wake-up was lost are read rather than
  dropped.
- `@dudousxd/nestjs-agent` (`/sink-redis`): a Streams subscriber to a run whose stream never
  appears gives up after `ttlSeconds` instead of polling until aborted.
