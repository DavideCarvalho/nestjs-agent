---
"@dudousxd/nestjs-agent": patch
---

Support ioredis 6: the optional `ioredis` peer is now `^5.0.0 || ^6.0.0`. `RedisTokenStreamSink` also reads the RESP3 map-shaped `XREAD` reply that ioredis 6 returns under `replyMapping: "resp3"` (the default `"legacy"` mapping, `protocol: 2` and ioredis 5 keep the array shape and work as before).
