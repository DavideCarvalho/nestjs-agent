---
"@dudousxd/nestjs-agent-data": minor
---

**Security:** the governed SQL tool's tenant scoping could be bypassed with `OR`. `TenantScopeRewriter` treated any `tenant_column = '<current tenant>'` it found in the WHERE as covering the query, even under an `OR`. So `WHERE tenant_id = 'mine' OR 1 = 1` got no constraint added and read every tenant's rows. The rewriter now always wraps the query's WHERE in parentheses and ANDs `<alias>.<tenant_column> = '<tenant>'` for every scoped table, in the top-level query and in every subquery. A literal naming another tenant is still refused. The added predicate is now always qualified with the table's alias.
