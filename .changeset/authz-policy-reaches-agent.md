---
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent-authz": patch
---

**Security:** `AgentAuthzModule.forRoot()` now actually reaches the agent. `AgentModule` bound its own `AGENT_ROLES_POLICY`, and Nest resolves a module's own provider before a global one, so the agent loop never saw the Gate-backed policy: the role-based default ran instead, ignored `ability`, and let every actor call an ability-gated tool that named no `roles`. `AgentModule` now forwards to an `AGENT_ROLES_POLICY` bound by another module (as it already did for `AGENT_STORE`), whatever the import order. An explicit `rolesPolicy` option still wins.

**Behavior change (fail closed):** `DefaultRolesPolicy` (and `ClosedRolesPolicy`) now refuse a tool that declares an `ability` and no `roles`, because they can't evaluate an ability. Before, such a tool was open to everyone unless `defaultRoles` said otherwise. A tool that declares both is still decided by its `roles`.
