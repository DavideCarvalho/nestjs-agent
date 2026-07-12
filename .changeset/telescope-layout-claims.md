---
'@dudousxd/nestjs-agent-telescope': minor
---

Live-feedback fixes for the Agent tab + automatic dedup:

- The recent-runs table no longer overflows its card: slimmed to started/run/agent/status/duration/
  error/promptHash (thread/actor/retries/errorCode detail lives in the standalone console; the
  provider row shape is unchanged).
- Run duration renders as p50/p95 stat panels — the previous `distribution` panel was a permanently
  empty histogram (the governance read has percentiles, not samples).
- The watcher claims its channels (diagnostics 0.7 claim registry, released on `dispose()`), so the
  generic diagnostics bridge skips them automatically — consumers delete their hand-written
  `agent:*` exclude lists.
