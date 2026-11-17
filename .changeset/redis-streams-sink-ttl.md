---
'@dudousxd/nestjs-agent': patch
---

The Redis Streams `RedisTokenStreamSink` arms the stream's TTL on the first write and re-arms it at most once a minute (for `ttlSeconds` plus that minute) instead of sending `EXPIRE` with every frame, and sets exactly `ttlSeconds` with the `end`/`fail` entry: 3 → 2 commands per frame with one subscriber.
