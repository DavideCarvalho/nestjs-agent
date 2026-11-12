---
'@dudousxd/nestjs-agent-mcp-server': minor
---

`devTools.authorize` gates the dev MCP endpoint's tools of libraries that have no console (resilience, authz, diagnostics, filter). It takes any console `authorize` form (function, class, lazy import, `{ policy, ability }`, gate name) and runs at most once per request; libraries with a console keep their own gate. Without it those libraries are open outside production and denied in production, with one boot warning naming them. A lib may now register without `authorize` when the slot `supports('endpoint-authorize')`, which the endpoint sets before any module registers. `@nestjs/authorization` is an optional peer (for the `{ policy, ability }` form).
