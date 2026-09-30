---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-ai-sdk": minor
"@dudousxd/nestjs-agent-testing": minor
"@dudousxd/nestjs-agent-authz": minor
---

Zero-config server: `AgentModule.forRoot({ model })` is the whole setup.

- **Store**: omit `store` and `AgentModule` uses the `AGENT_STORE` another module binds (a store module — found by scanning the container, whatever the import order), else the built-in in-memory store with a boot warning that it is not for production. `InMemoryAgentStore` moves into `@dudousxd/nestjs-agent-core` (the `-testing` package re-exports it).
- **Identity**: `actorResolver` is optional. Without one the endpoints are public and every browser is its own anonymous actor — `AnonymousActorResolver`: a random token in an `HttpOnly`, `SameSite=Lax` cookie (`Secure` over HTTPS), the actor id `anon:<sha256 digest>` of it — so visitors never share threads, quota or attachments. A boot notice says the endpoints are public. `requestUserActorResolver(map?)` requires login in one line, reading `req.user` (Passport / cookie-session apps), `401` without it.
- **Tools**: `@AiTool` `kind` defaults to `'read'` and `name` to the class name camelCased minus `Tool` (`GetWeatherTool` → `getWeather`); only `description` and `input` are required.
- **Prompt**: module-level `systemPrompt` (string, or `(ctx) => string`) for the default agent and any `@Agent` without its own.
- **Models**: `aiSdkModels({ id: model | { model, label, badges, … } }, { default })` from `@dudousxd/nestjs-agent-ai-sdk` returns a provider carrying `.catalog`, which `AgentModule` lists when `models` is omitted.

**Breaking**

- Tools no longer default to `['ADMIN']`: `DefaultRolesPolicy`'s default `defaultRoles` is `[]`, which restricts nobody — any resolved actor (anonymous included) can call a tool that names no `roles`. Explicit `@AiTool({ roles })`, `defaultRoles` and `rolesPolicy` still restrict. `action` tools still park on approval (by default the requester approves — for an anonymous visitor a confirmation, not an authorization). To keep the old behaviour: `AgentModule.forRoot({ defaultRoles: ['ADMIN'] })` (and `new AuthzRolesPolicy(gate, { fallbackRoles: ['ADMIN'] })`, whose fallback follows the same default).
- `AgentModuleAsyncOptions.externalStore` is removed — a store module's `AGENT_STORE` is found automatically. `AGENT_STORE` is now always bound (and exported) by `AgentModule`.
- `aiSdkModel`'s `resolveModel` option is removed, and a turn that picks a model the provider does not serve now fails instead of silently running on the bound model (a gateway id is no longer swapped for the pick). Use `aiSdkModels({ … })` for several models.
- `@dudousxd/nestjs-agent-testing` requires `@dudousxd/nestjs-agent-core` `>=0.27.0`.
