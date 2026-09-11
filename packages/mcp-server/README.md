# @dudousxd/nestjs-agent-mcp-server

An [MCP](https://modelcontextprotocol.io) **server** for
[`@dudousxd/nestjs-agent`](../nestjs). It mounts a Streamable HTTP endpoint on your app, and an
external MCP client — Claude Desktop, an editor, a CI job — reaches the tools this deployment
already has, through the same gates a turn goes through.

The opposite direction to [`@dudousxd/nestjs-agent-mcp`](../mcp), which IMPORTS a remote server's
tools into this app. The two share nothing but the SDK: one treats a remote tool as untrusted input,
the other treats a remote caller as an untrusted caller.

## Install

```bash
pnpm add @dudousxd/nestjs-agent-mcp-server @dudousxd/nestjs-agent @dudousxd/nestjs-agent-core
```

## Mount it

```ts
import { AgentModule } from '@dudousxd/nestjs-agent';
import { AgentMcpServerModule, BearerTokenActorResolver } from '@dudousxd/nestjs-agent-mcp-server';

@Module({
  imports: [
    AgentModule.forRoot({ /* … */ }),
    AgentMcpServerModule.forRoot({
      name: 'Acme Agent',
      version: '1.0.0',
      auth: new BearerTokenActorResolver([
        { token: process.env.MCP_CI_TOKEN ?? '', actor: { id: 'ci', roles: ['ANALYST'] } },
      ]),
    }),
  ],
})
export class AppModule {}
```

`POST|GET|DELETE /mcp` is the endpoint (`path` moves it). Import it **after** `AgentModule`, whose
global `AGENT_TOOL_REGISTRY` and `AGENT_ROLES_POLICY` it serves from.

`forRootAsync` takes the usual `imports` / `inject` / `useFactory` for auth that only exists at
runtime — a key list from config, a JWT verifier built from a secret.

## What a caller gets, and why

**The same registry and the same policy as a turn.** `tools/list` is
`ToolRegistry.definitionsFor(actor, policy, allowedTools)` — the agent's own four filter layers
(allow-list, `enabled`, `RolesPolicy`, the tool's `canUse`) — and `tools/call` is
`ToolRegistry.invoke`, which re-checks all of them and re-validates the input before the handler
runs. There is no second gate here to drift out of step with the loop's.

**An `action` tool is not callable by default.** In a turn, an `action` parks for a human to approve
it. Nobody is attached to an MCP connection, so the approval the tool was declared to require cannot
happen: it is neither listed nor callable. `actions: 'execute'` is the deployment stating that this
caller may act without approval — it removes the human from every `action` the caller's roles reach,
so narrow it with `allowedTools` and with the roles you put on the identity.

**Loop-served kinds are never exposed.** `agent` (handoff) tools are registered with a stub handler
because the LOOP performs the delegation; `ask`, `skill` and `memory` are served against a run and
are never registered. Reaching any of them through the registry performs nothing, so this surface
refuses them whatever `actions` says.

**Identity is required, and never invented.** `auth` is an `ActorResolver` — the same seam
`AgentModule.forRoot({ actorResolver })` takes — with no default and no fallback actor. A caller it
cannot identify is answered **401**, not 500. An actor with no roles reaches no tools, which is the
right starting point for a new integration.

**A session belongs to the actor that opened it.** The session id travels in a plain header and owns
an open SSE stream; a request that authenticates as somebody else is answered 403 rather than served
on it. Unknown session id → 404, so a client re-initializes.

**`allowedTools` is enforced on the call, not only on the list.** `ToolRegistry.invoke` knows nothing
about it, so a caller who simply guesses a name would otherwise reach a tool this deployment
deliberately left off its MCP surface.

## Options

| Option | Default | What it does |
|---|---|---|
| `name`, `version` | — | Reported in the initialize handshake |
| `auth` | — (required) | `ActorResolver` deciding who the caller is; must throw to reject |
| `path` | `'mcp'` | Route the endpoint mounts at |
| `actions` | `'deny'` | `'execute'` lets `action` tools run with no human approval |
| `allowedTools` | every exposable tool the actor may use | The names this surface exposes at all |

## Authenticating callers

`BearerTokenActorResolver` covers the machine-to-machine case: a fixed list of issued tokens, each
bound to the actor it acts as, compared in constant time, 401 on anything else. It refuses to be
constructed with an empty token, which a bare `Authorization: Bearer ` header would otherwise match.

When the caller is a PERSON your app already knows, pass the resolver you gave `AgentModule` instead,
so one user has one set of roles on both surfaces. Any resolver works: read a session, verify a JWT,
call your gateway. Reject by throwing — an `UnauthorizedException` keeps the 401, and a plain `Error`
is mapped to one rather than becoming a 500.

## Beyond this package

- **Rate limiting, IP allow-lists, DNS-rebinding checks** are host middleware on the route. The MCP
  SDK's own `allowedHosts`/`allowedOrigins` options are deprecated in favour of exactly that.
- **Sessions are held in memory, per pod.** A fleet behind a load balancer needs session affinity on
  the MCP route, or a client's second request lands on a pod that never saw its `initialize`.
- `McpSessionStore` is exported: how many sessions this process holds, and a `close()` that runs on
  application shutdown.
