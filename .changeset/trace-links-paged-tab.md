---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': patch
'@dudousxd/nestjs-agent-store-mikro-orm': minor
'@dudousxd/nestjs-agent-store-drizzle': minor
'@dudousxd/nestjs-agent-testing': minor
'@dudousxd/nestjs-agent-telescope': minor
'@dudousxd/nestjs-agent-react': patch
---

Trace navigation + paged Agent tab + headless docs:

- Tool calls carry their `runId` end to end (RecordToolCallInput → both stores' nullable run_id →
  ToolCallActivityRow/PendingApprovalRow), and `RunWhere.threadId` filters runs by thread — every
  activity row can now deep-link to its run's trace.
- Telescope Agent tab: tool-call/run rows link to the TRACES waterfall (`#/traces/{runId}`,
  internal default); the three activity tables use the paged SPI reads with real pagination
  controls (`paged: true`, telescope >= 1.18, dep floor raised); the dashboard regrouped into six
  coherent sections with no orphan half-width panels.
- react README documents "Bring your own UI" — the package is headless by design; the snippets
  compile against the current API.
