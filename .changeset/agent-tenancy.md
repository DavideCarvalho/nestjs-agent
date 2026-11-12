---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-dashboard": minor
"@dudousxd/nestjs-agent-testing": minor
"@dudousxd/nestjs-agent-store-drizzle": minor
"@dudousxd/nestjs-agent-store-mikro-orm": minor
---

Tenancy: the agent can follow the request's tenant from `@dudousxd/nestjs-context` (read structurally, no new dependency). Off unless the app turns it on.

- `AgentModule.forRoot({ tenancy })`: `'inherit'` (default, follows `ContextModule`'s `tenancy.enabled`), `false`, or `{ enabled, kinds, nullRows }`. `enabled: true` without a `ContextModule` to read the tenant from fails the boot.
- With tenancy on, an actor your `actorResolver` returns without a `tenantRef` gets the context tenant's id. A resolver that sets `tenantRef` wins.
- Thread and run reads apply the matching rule: thread list, detail, delete, fork, update and queue, run streams (subscribe, resume, cancel), tool-call decisions and action proposals. A thread or run of another tenant answers `404`, never `403`. Rows with no tenant are visible only to requests without one, unless `nullRows: 'shared'`.
- The governance dashboard shows the viewer's context tenant, and its approvals inbox checks the tool call's tenant.
- `AgentService.recordUsage` records the context tenant when the input names no `tenantRef`. `AgentService.listThreads` also takes an `Actor`.
- `quota.per: 'actor' | 'tenant' | 'actor-in-tenant'` (default `'actor'`, today's behaviour) sums the built-in quota's windows by `Actor.tenantRef`.
- Store SPI: optional `tenantOf`, `listThreadsForTenant` and `usageWindowsForTenant`, plus governance `forTenant`. The in-memory, Drizzle and MikroORM stores implement them. Drizzle and MikroORM add an `agent_token_usage (tenant_ref, created_at)` index on boot (MikroORM schema revision 7).
- An action proposal belongs to its thread's tenant, the one listing and deciding it check, even when the turn's actor carries another.
- The MikroORM schema heal only creates and adds: it no longer runs the index, foreign-key or column drops the safe diff emits, so a store one release behind (a rollback, an old replica) keeps the indexes a newer release added, and the indexes the host added to agent tables stay.
- Core exports the local tenancy reader: `readTenancy`, `tenantRowFilter`, `tenantRowVisible` and `withContextTenant`.

- Rolling back the MikroORM store below this release (e.g. to 0.42.x) drops `agent_token_usage_tenant_created_idx` on that boot: older stores heal by dropping indexes they do not declare. The next boot on this release adds it back. From this release on, the heal never drops anything.
