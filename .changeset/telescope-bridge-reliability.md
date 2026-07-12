---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent-telescope': minor
---

Telescope bridge catches up with the governance data (audit items 1-8, 10):

- The Agent tab surfaces the durable governance reads: Reliability (success/error rate stats, run
  duration as a `distribution` panel with p50/p95 markers, runs-by-agent, error breakdown, run
  trend, recent runs with promptHash chips and 500-char-capped errorMessage — `DataProvider`
  output bypasses Telescope's entry-level `redact()`, so the provider self-caps), durable recent
  tool calls / threads, pending-approvals count + table, and tool stats.
- The watcher now records ALL agent diagnostics events — `run.failed`, `delegated`, and
  `retrieved` were silently dropped — driven by the new canonical `AGENT_DIAGNOSTIC_EVENTS` export
  (compile-time-checked against the channel registry) + `agentDiagnosticKey()` helper (core). Pass
  those keys to the generic diagnostics bridge's `exclude` to avoid double-recording (doc note
  added, mirroring the media bridge).
- `agentTelescopeExtension({ threadHref?, runHref? })` — deep-link columns on every thread/run
  table, matching the durable/media bridges' convention. The watcher gained `dispose()`.
- The ephemeral event-storage tools provider is deprecated and no longer bundled: the durable
  writes always land before the diagnostics event fires, and only the durable read-model sees
  `pending_approval`, so the ephemeral view had no unique value left.
