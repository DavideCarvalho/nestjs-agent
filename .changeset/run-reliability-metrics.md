---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
'@dudousxd/nestjs-agent-store-mikro-orm': minor
'@dudousxd/nestjs-agent-store-drizzle': minor
'@dudousxd/nestjs-agent-testing': minor
'@dudousxd/nestjs-agent-dashboard': minor
---

Run reliability metrics — run outcomes are now durably recorded and surfaced as governance reads
and a dashboard Reliability section:

- Store SPI: optional `recordRunStart`/`recordRunEnd`/`bumpRunRetries` on `AgentStore` (absent =
  graceful no-op). The loop records start/completed (with duration) as checkpointed steps; the
  runners (durable workflow + inline) record failures with error code/message. Both bundled store
  adapters ship the new `agent_run` table (autoSchema-managed, in the managed-tables lists).
- `AgentGovernanceQueries` grew `runMetrics`, `runsByAgent`, `runErrors`, `runTrend`, `recentRuns`
  (REQUIRED members — external adapters must implement them; return zeros/empty when the backing
  store never records runs). In-memory testing impls included.
- Dashboard: `GET <api>/reliability?from&to` + `GET <api>/runs?limit`, and a Reliability section in
  the SPA — success/error rate, retries, p95 duration, run/failure trend, failure breakdown by
  error code, recent runs table.
- `DispatchedLlmInput` carries `runId` so llm-step retries can be attributed to the run; the retry
  counter stays 0 until the durable runtime exposes the attempt number to remote step handlers.
