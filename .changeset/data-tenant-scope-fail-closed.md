---
"@dudousxd/nestjs-agent-data": minor
---

Tighten the governed SQL tool:

- **Behavior change:** `TenantScopeRewriter.rewrite` now refuses a query on a scoped table when the actor has no `tenantRef`. Before, it ran the query unscoped. To keep the old "no tenant means every tenant" path, pass `onMissingTenant: 'passthrough'`. Queries that read no scoped table still run.
- Subqueries are now scoped too. A scoped table read in a subquery in the select list, `WHERE`, `HAVING` or a `JOIN ... ON` used to run unconstrained. CTEs, set operations and subqueries in `FROM` are refused at any depth.
- **Behavior change:** `injectLimit` (and so `executeSql`) caps an explicit `LIMIT` larger than `maxRows`. Before, any explicit `LIMIT` was trusted.
