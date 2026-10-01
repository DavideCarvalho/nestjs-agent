---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": patch
"@dudousxd/nestjs-agent-testing": minor
"@dudousxd/nestjs-agent-store-drizzle": minor
"@dudousxd/nestjs-agent-store-mikro-orm": minor
---

A `TokenStreamSink` over SQL — several replicas without Redis (port of adonis-agora-agent#234).

```ts
AgentModule.forRoot({ model, sink: new DrizzleTokenStreamSink(db) });
// or: useFactory: (em: EntityManager) => ({ model, sink: new MikroOrmTokenStreamSink(em) })
```

One row per frame in `agent_stream_frame`, numbered per run with no gaps (`MAX(seq) + 1` in the insert; the `(run_id, seq)` key turns a race into a retry); any replica serves and resumes the SSE by polling. Consecutive `text` frames are coalesced at write time (`flushMs`, 50 ms), so every replica reads the same rows and `?after=` cursors stay exact. TTL counts from the run's last write (`ttlSeconds`, 1 h); `purgeExpired()` runs on its own after a run ends. A run that `fail()`s ends with a terminal row carrying the error. Polling only.

- core: `SqlTokenStreamSink` (the logic) over a `StreamFrameTable` (the SQL), and `SinkWriter.flush?()` — write out what a writer holds back without ending the stream.
- nestjs: `childSinkWriter` flushes on `end` / `fail`, so a delegated run's gathered text lands before its parent's next frame.
- store-drizzle / store-mikro-orm: `DrizzleTokenStreamSink` / `MikroOrmTokenStreamSink` and the `agent_stream_frame` table (`ensureAgentSchema`; MikroORM: also in `agentEntities()` / `agentManagedTables()`).
- testing: `SQL_TOKEN_STREAM_SINK_CONTRACT` and `InMemoryStreamFrameTable`.
