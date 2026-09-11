---
'@dudousxd/nestjs-agent-mcp-server': minor
---

An external MCP client can now reach this deployment's tools — through the gates a turn goes
through, and no wider.

`@dudousxd/nestjs-agent-mcp-server` mounts a Streamable HTTP MCP endpoint (`POST|GET|DELETE /mcp`)
on the app. `tools/list` is `ToolRegistry.definitionsFor(actor, policy, allowedTools)` and
`tools/call` is `ToolRegistry.invoke` — the agent's OWN registry and the injected
`AGENT_ROLES_POLICY`, not a second gate written to agree with them. A role-checked tool stays
role-checked, a `canUse` still runs, a disabled tool is still absent, and the input is re-validated
against the real schema before any handler does.

It is a package of its own rather than a second entry point on `@dudousxd/nestjs-agent-mcp`. The
two directions share no code: the client's public surface is entirely about importing a remote
server's tools (`McpToolSource`, `localToolName`, `isTransientMcpError`), it needs no HTTP surface —
a worker pod imports tools without one — and the server needs `@nestjs/core` and a mounted
controller that the client's peer set does not ask for.

**An `action` tool is not callable here by default.** In a turn an `action` never auto-executes: it
parks until a person approves it. Nobody is attached to an MCP connection, so that approval cannot
happen, and the answer is to keep the tool off a surface that cannot honour its gate — it is neither
listed nor callable. `actions: 'execute'` is the deployment stating that this caller may act without
approval; it removes the human from every `action` the caller's roles reach, which is why it is a
named option rather than the default.

**Loop-served kinds are never exposed, whatever `actions` says.** A handoff (`agent`) tool is
registered with a stub handler because the LOOP performs the delegation — invoking it through the
registry answers `{}` and delegates to nobody. `ask`, `skill` and `memory` are settled against a run
and are never registered at all. Refusing them keeps that true of this surface even if something
registers one out of band.

**`allowedTools` is enforced on the call, not only on the list.** `ToolRegistry.invoke` knows nothing
about the allow-list — `definitionsFor` applies it where the LIST is built, and nothing applies it on
the way in. Without the second check a caller who simply guesses a name reaches a tool the deployment
deliberately left off its MCP surface.

**Identity is required and never invented.** `auth` is an `ActorResolver` — the same seam
`AgentModule.forRoot({ actorResolver })` takes — with no default and no fallback actor: pass the
resolver your app already uses, or the bundled `BearerTokenActorResolver` (a fixed list of issued
tokens, each bound to the actor it acts as, compared in constant time, and refusing to be
constructed with an empty token, which a bare `Authorization: Bearer ` header would match). A caller
that cannot be identified is answered **401**, not 500 — including one whose host resolver threw a
plain `Error`, which would otherwise reach the client as "Internal server error" with a logged stack.
No role is granted by default either: an actor with no roles reaches no tools.

**A session belongs to the actor that opened it.** The MCP session id travels in a plain header and
owns an open SSE stream that answers are written to. A request that authenticates as a different
actor is refused 403 rather than served on it; an unknown id is 404, so a client re-initializes
instead of retrying a session this process no longer holds.

**Not in scope, deliberately.** There is no approval flow for MCP callers: parking a `tools/call` on
a human decision means a run, a persisted tool-call row and a signal to wait on, and a half-built
version of that is worse than an explicit refusal. Rate limiting, IP allow-lists and DNS-rebinding
checks are host middleware on the route. Sessions are in-memory per pod, so a fleet needs session
affinity on the MCP route.

This closes the last `to build` row in `PARITY.md`: the MCP server originated in `adonis-agent`, and
now exists on both sides.
