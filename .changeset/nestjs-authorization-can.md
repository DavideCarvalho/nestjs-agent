---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-mcp": minor
"@dudousxd/nestjs-agent-mcp-server": minor
"@dudousxd/nestjs-agent-poppy": minor
"@dudousxd/nestjs-agent-channels": patch
"@dudousxd/nestjs-agent-dashboard": patch
"@dudousxd/nestjs-agent-opencode": patch
---

Tool authorization is NestJS's `@nestjs/authorization`. A tool's `@Can()` — on an `@AiTool` class or its `execute()`, on an `@AgentFunction()` method, on a route exposed with `@Mcp()` — is read off the decorator: an ability that needs only the user decides whether the model (or an MCP client) is offered the tool, asked of `AuthorizationService` for the turn's actor, and the guard checks every call; an ability whose arguments read the call is the guard's alone. `staticCanArgs(...)` marks fixed arguments so they gate the offer too.

Breaking:

- `ability: string` is gone from `ToolSpec`, `@AiTool`, `@Mcp()`, `@Agent({ handoff })`, `genuiTools` / `AgentGenuiModule` and the MCP-client and Poppy options. Tools with nothing to decorate take `can: [{ policy, ability }]` instead; `@Mcp({ ability })` refuses the boot and points at `@Can()`.
- `@dudousxd/nestjs-agent-authz` is removed (`AgentAuthzModule`, `AuthzRolesPolicy`): use `@nestjs/authorization`'s `AuthorizationModule` and `@Can()`.
- A tool that requires an ability with no `AuthorizationModule` imported reaches nobody (fail closed); an `@AiTool` whose `@Can()` reads the call refuses the boot without `AiModule`, since only its guard could check it.

`AuthorizationModule`'s global guard denies whatever declares no `@Can()`. The library's own controllers, and the tools it governs (`@AiTool`, this library's `@AgentFunction()`), carry `CanAnyone()` (`Can.Anyone()`'s mark, without the dependency): the actor resolver, `guards` and the roles policy decide who reaches them, and a `@Can()` they declare is still checked.
