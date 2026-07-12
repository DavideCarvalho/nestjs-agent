---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent-store-mikro-orm': minor
'@dudousxd/nestjs-agent-store-drizzle': minor
'@dudousxd/nestjs-agent-testing': minor
'@dudousxd/nestjs-agent-dashboard': minor
---

Console navigability + paginated, queryable lists:

- Sections live on ROUTES now — hash routing (`/ai-gateway#/reliability`, `#/approvals`, …),
  deep-linkable on full page load, consistent with the durable console, zero new dependencies.
- The list surfaces (tool calls, threads, runs) are paginated and filterable end to end:
  `AgentGovernanceQueries` grew `toolCallsPage`/`threadsPage`/`runsPage` (neutral
  `GovernancePageQuery` with typed `where` — REQUIRED members, implemented in both bundled stores
  with real COUNT + offset, deterministic id tiebreaks, case-insensitive title search, one-sided
  day bounds; in-memory testing impls included). The dashboard API speaks the ecosystem's familiar
  wire grammar (`page`, `limit`, `where[field]=value`, unknown field → 400) and the SPA tables get
  prev/next pagination with per-table debounced filters. The latest-N reads remain for the
  telescope bridge.
