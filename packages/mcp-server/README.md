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

## A route you already wrote

Your app already states its capabilities as routes, with validated DTOs and the authorization their
author wrote. `@Mcp()` exposes one as a tool, so the statement is made once:

```ts
@Controller('orders')
export class OrdersController {
  @Get(':id')
  @UseGuards(JwtGuard, OrderAccessGuard)
  @Mcp({ kind: 'read', description: 'Read one order by its id.', roles: ['ANALYST'] })
  findOne(@Param('id', ParseIntPipe) id: number) { ... }
}
```

A client sees `orders_find_one`, taking `{ params: { id } }` — derived from the route's own
`@Param()` / `@Query()` / `@Body()` declarations.

**A call runs through the request pipeline, not the method.** Dispatch goes through Nest's
`ExternalContextCreator`: the `@UseGuards` run first, against an `ExecutionContext` whose
`switchToHttp().getRequest()` is the dispatched request; then the param pipes and your global ones;
then the interceptors; then the handler. Calling the method would skip all of it — which is to say
it would skip the authorization that made the route safe to expose.

**A guard's refusal fails the call.** An `HttpException` escaping the route comes back as a protocol
error carrying the status it chose (`data: { httpStatus: 403 }`), not a result with an error in it:
a 403 reported as tool output reads to a model as "try different arguments".

**`kind` is explicit, never inferred.** A `GET` can have a side effect and a `POST` is often a
search. Omitting `kind` does not compile, and does not boot.

**The MCP actor is the principal.** The resolved `Actor` goes on `request.user`, where a roles guard
reads it. Nothing is carried over from the inbound MCP request — that credential authenticated the
caller to *this* surface, and replaying it at an internal route would re-authenticate a token your
guards never meant to accept, and let an MCP caller choose the headers in front of them. Supply
`routes.principal` where your guards read something else.

```ts
AgentMcpServerModule.forRoot({
  /* … */
  routes: { principal: ({ actor }) => ({ user: toClaims(actor) }) },
});
```

**The same gates, on a second door.** Route-derived tools are ordinary `ToolSpec`s: the `RolesPolicy`
is asked about them, `enabled` drops them, an `action` is neither listed nor callable without
`actions: 'execute'`, and `allowedTools` is re-checked on the call. They live in a registry of their
own so mounting an MCP server does not change what the agent loop offers a model, and a name claimed
by both a route and an `@AiTool` fails the boot naming both claimants.

**Two things a real request has are absent, deliberately.** Middleware does not run — it is bound to
the HTTP server's routing table, and there is no HTTP server in this path; in Nest, authorization is
a guard, and guards do run. Exception filters do not run — a filter renders an error into an HTTP
response, and a global one answering `200` with an error body would turn a guard's refusal into a
call that looks like it succeeded.

### What fails the boot, naming the route

| Declaration | Why |
|---|---|
| No `kind`, or no `description` | Nothing is inferred from the verb, and a model reads the description |
| `@All()` | A dispatched request has to carry one definite verb |
| `@Res()` / `@Next()` | The route writes the response itself, so it returns nothing to answer with |
| `@Session()` · `@UploadedFile(s)()` · `@RawBody()` | An MCP call carries JSON arguments and none of these |
| A request-scoped controller | There is no request to build the instance from |
| A name an `@AiTool` or another route already claims | A registry keeps the last writer, so the winner would depend on load order |

### The input schema it derives

| Declaration | Advertised as |
|---|---|
| `@Param()` | Every `:name` in the path, each a required string |
| `@Param('id')` | Just `params.id`, required |
| `@Query('limit') limit: number` | `query.limit` typed from the declaration, never required |
| `@Query() dto: SearchDto` | An open `query` object |
| `@Body('term') term: string` | `body.term`, required |
| `@Body() dto: CreateOrderDto` | An open `body` object named after the DTO |

The last two rows are the honest limit: a DTO's fields are erased by the time the app runs and only
its constructor survives, so that slot is open. Nothing is lost but a hint to the model — the route's
own `ValidationPipe` still judges what arrives in it.

Path and query values are reduced to the text an HTTP request delivers, so a `ParseIntPipe` parses
what it would have parsed on the wire.

## Options

| Option | Default | What it does |
|---|---|---|
| `name`, `version` | — | Reported in the initialize handshake |
| `auth` | — (required) | `ActorResolver` deciding who the caller is; must throw to reject |
| `path` | `'mcp'` | Route the endpoint mounts at |
| `actions` | `'deny'` | `'execute'` lets `action` tools run with no human approval |
| `allowedTools` | every exposable tool the actor may use | The names this surface exposes at all |
| `routes.principal` | the actor on `request.user` | How the MCP actor becomes the dispatched request's principal |

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
- **Middleware and exception filters** do not run for a `@Mcp()` route — see above for why.
- **A request-scoped controller** cannot be dispatched against — there is no request to build one
  from — so `@Mcp()` on one fails the boot rather than being skipped.
