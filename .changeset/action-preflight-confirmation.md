---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-react": minor
"@dudousxd/nestjs-agent-store-drizzle": minor
"@dudousxd/nestjs-agent-store-mikro-orm": minor
---

Add read-only action preflight checks before approval and before execution, with ready, denied,
and completed outcomes. Journal preparation and execution refusals so replay cannot change the
approval branch or rerun a denied mutation. Direct registry and MCP invocation also checks state.

Persist and stream per-call confirmation wording and render it through the existing React
transcript. Add a nullable confirmation JSON column to both SQL stores.
