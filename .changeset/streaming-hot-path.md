---
"@dudousxd/nestjs-agent-core": patch
"@dudousxd/nestjs-agent": patch
"@dudousxd/nestjs-agent-transport-redis": patch
---

Cheaper streaming: the output gate, the token sinks and the SSE routes no longer do per-token work
that grows with the answer, and a reader that disconnects stops costing anything.

- `@dudousxd/nestjs-agent-core`: an incremental output gate rules on the growing answer once it has
  grown by half the lookback window (or 250 ms after its last pass) instead of on every token, and
  rules on whatever is left when it settles, so what it has released by the end is unchanged. A
  16k-token answer under `createGuardrails({ pii, secrets })` drops from ~8 s to ~0.3 s of CPU.
  Guardrails load the thread's vault once per gate rather than once per prefix, keyword detectors
  compile their word list once, and the turn's frame observers no longer `JSON.parse` every token.
  `TokenStreamSink.subscribe` takes an optional `{ signal }`; aborting it ends the subscription even
  while the run is silent. `SqlTokenStreamSink` honours it.
- `@dudousxd/nestjs-agent`: the default `InProcessTokenStreamSink` drops a run's buffer 60 s after it
  ends, or an hour after its last write if it never does — it used to keep every run's chunks for
  the life of the process — and a subscriber of a run that has not been opened yet no longer
  creates an entry. `chat`, `chat/:runId/stream`, AG-UI and A2UI end their subscription when the
  client disconnects. The Redis Streams sink (`/sink-redis`) gathers consecutive text frames while a
  send is on the wire and pipelines `XADD` + `EXPIRE` (2000 tokens: 6008 Redis commands → 9), and a
  subscriber stops when its stream expired or was closed without an end marker, or when it aborts —
  closing its duplicated connection either way.
- `@dudousxd/nestjs-agent-transport-redis`: `RedisTokenStreamSink` gathers consecutive text frames
  the same way (2000 tokens: 10004 Redis commands → 15), and a subscriber reads the terminal marker
  only on attach and once the run ends rather than on every wake.
