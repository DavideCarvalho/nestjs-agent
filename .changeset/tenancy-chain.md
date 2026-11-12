---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
'@dudousxd/nestjs-agent-dashboard': minor
---

Tenancy follows the full `@dudousxd/nestjs-context` contract (2.1+), and still works with older contexts.

- **Nested tenants.** `tenancy: { kinds }` picks the level of the request's tenant chain. With `kinds: ['clinic']`, a request in a unit gets its clinic as `tenantRef`, so every unit of a clinic shares its threads, runs, the console and `quota.per: 'tenant' | 'actor-in-tenant'`. `family` scopes by a secondary tenant.
- **`required`.** From the agent's `tenancy.required`, else the context's. With no tenant, thread and run reads, a new thread and the console answer 403 (`E_TENANT_REQUIRED`) instead of running tenantless. An actor whose resolver sets `tenantRef` is never refused. Work outside a request never throws: `recordUsage` (workers, durable turns, schedules) and the actor resolver read with `required: false`, and the console search answers no hits.
- **Organization labels.** `GET <api>/tenancy` returns the Organization the console is scoped to, each level labelled by the context's `tenancy.label` (else slug, else id). The console header shows it.
- Core exports `tenantLabels`, `ContextTenantLevel` and `ReadTenancyOverrides`. `readTenancy` takes an optional third argument, `{ required }`.
