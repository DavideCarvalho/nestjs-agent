---
'@dudousxd/nestjs-agent-transport-redis': minor
---

`RedisTokenStreamSink` costs about 2 Redis commands per streamed frame instead of 3 for the writer plus 1 per subscriber (measured with a real Redis at 400 tokens 20 ms apart: 4.02 → 2.02 per frame with one subscriber, 6.04 → 2.04 with three). The `PUBLISH` now carries the frames and their list index, so live subscribers append them directly and read the list with `LRANGE` only to catch up: on attach, when a published index skips past what they have, when a message carries no frames, and at the end. The TTL is armed on the first write and re-armed at most once a minute (for `ttlSeconds` plus that minute) instead of on every frame, and set to exactly `ttlSeconds` on both keys when the run ends or fails.

`RedisStreamClient.rpush` may now resolve to the list length (`Promise<number | void>`), as `ioredis` and `node-redis` do; an adapter that resolves to nothing keeps working with bare wakes. Old and new writers and subscribers interoperate during a rolling deploy.
