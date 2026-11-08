---
"@dudousxd/nestjs-agent": patch
"@dudousxd/nestjs-agent-core": patch
"@dudousxd/nestjs-agent-dashboard": patch
"@dudousxd/nestjs-agent-poppy": patch
"@dudousxd/nestjs-agent-transport-redis": patch
---

Docs: the boot warning about both a `rolesPolicy` option and a bound `AGENT_ROLES_POLICY` no longer names the removed `AgentAuthzModule` (ability checks are `@Can()` from `@nestjs/authorization`). `CanAnyone()`'s doc names `decorators`, not the removed `guards`. The dashboard README no longer refers to the removed `./react` entry, the Poppy README says its 1.0 is not a stability promise, and `transport-redis` ships a README.
