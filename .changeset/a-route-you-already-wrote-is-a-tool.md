---
'@dudousxd/nestjs-agent-mcp-server': minor
---

`@Mcp()` — expose a controller route you already wrote as an MCP tool.

Every Nest app already states its capabilities as routes, with validated DTOs and
the authorization its author wrote. Re-declaring each one as an `@AiTool` is the
same statement twice, and the copy drifts.

```ts
@Controller('orders')
export class OrdersController {
  @Get(':id')
  @UseGuards(JwtGuard, OrderAccessGuard)
  @Mcp({ kind: 'read', description: 'Read one order by its id.', roles: ['ANALYST'] })
  findOne(@Param('id', ParseIntPipe) id: number) { ... }
}
```

An MCP client sees `orders_find_one`, taking `{ params: { id } }` — derived from
the route's own `@Param()` / `@Query()` / `@Body()` declarations.

**A call runs through the route's request pipeline, not its method.** Dispatch
goes through Nest's `ExternalContextCreator`, the seam Nest itself uses to run a
controller method from a transport that is not HTTP: the `@UseGuards` run first,
against an `ExecutionContext` whose `switchToHttp().getRequest()` is the
dispatched request; then the param pipes and the app's global ones; then the
interceptors; then the handler. Calling the method directly would skip all of it
— which is to say it would skip the authorization that made the route safe to
expose in the first place.

A route that fails its own guard fails the MCP call, as a protocol error carrying
the status the route chose (`data: { httpStatus: 403 }`), not a result with an
error in it.

**`kind` is explicit and never inferred.** A `GET` can have a side effect and a
`POST` is often a search, so deriving it from the verb is wrong in both
directions. Omitting it does not compile, and does not boot.

**The MCP actor is the principal.** The resolved `Actor` is put on
`request.user`, where a roles guard reads it. Nothing is carried over from the
inbound MCP request — the credential presented to `/mcp` authenticated the caller
to *that* surface, and replaying it at an internal route would both
re-authenticate a token the route's guards never meant to accept and let an MCP
caller choose the headers in front of them. `routes.principal` is the seam for a
deployment whose guards read something else.

**The same gates, on a second door.** Route-derived tools are ordinary
`ToolSpec`s in a registry of their own: the `RolesPolicy` is asked about them,
`enabled` drops them, an `action` is neither listed nor callable without
`actions: 'execute'`, and `allowedTools` is re-checked on the call. The registry
is separate from the agent's so that mounting an MCP server does not change what
the loop offers a model, and a name claimed by both a route and an `@AiTool`
fails the boot naming both claimants.

**What fails the boot**, each naming the route: no `kind`, no description, a
route with no single verb (`@All()`), and a route declaring `@Res()`, `@Next()`,
`@Session()`, `@UploadedFile(s)()` or `@RawBody()` — slots a dispatched call has
nothing to fill.
