---
'@dudousxd/nestjs-agent-store-drizzle': patch
---

Accept the Drizzle database every host actually builds.

`AgentDrizzleDb` left the schema generic at its default, `Record<string, never>`, so a handle built
the documented way — `drizzle(client, { schema })`, which is what `agentSchema` exists for — was not
assignable to it. `ExtractTablesWithRelations` is invariant, so the error was a wall of `Type
'"agent_thread"' is not assignable to type 'never'` at the constructor call, and the way out was a
cast in host code.

The type now names `TablesRelationalConfig` explicitly, which a schema-aware handle satisfies. One
change; it cleared all 38 occurrences in this package's own db specs, which is where it was found —
those specs are now type-checked by `pnpm typecheck:specs`, so the next one fails the build instead
of being invisible to CI.

**Upgrading.** Nothing to run. A host that worked around this with a cast can drop it.
