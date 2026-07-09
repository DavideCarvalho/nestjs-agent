---
"@dudousxd/nestjs-agent-core": patch
"@dudousxd/nestjs-agent-store-mikro-orm": patch
"@dudousxd/nestjs-agent-store-drizzle": patch
"@dudousxd/nestjs-agent-testing": patch
"@dudousxd/nestjs-agent-codegen": patch
"@dudousxd/nestjs-agent-telescope": patch
---

Behavior-preserving simplification pass across the governance surfaces.

- **core**: extract the shared, pure governance aggregation helpers
  (`estimateCost`, `bucketByModel`, `bucketByActor`, `bucketByThread`,
  `bucketUsageTrend`, `dayBoundsUtc`) so the cost formula, bucketing, and
  day-bounds math live in one place.
- **store-mikro-orm / store-drizzle / testing**: the three
  `AgentGovernanceQueries` adapters now only fetch their DB-specific rows,
  map them to the shared `GovernanceUsageInput` shape, and call the core
  helpers — deleting the duplicated cost/bucket/day-bounds code.
- **codegen**: fix the `USAGE`/`StoredMessage` wire contracts that had
  drifted from core's real types, and inject the four missing controller
  routes (agents catalog, thread rename/promote/truncate-from-message).
- **telescope**: collapse the eight governance data providers into a single
  `governanceStatProvider(name, fetch, format)` factory.
