# @dudousxd/nestjs-agent-mcp-server

## 0.3.2

### Patch Changes

- [#319](https://github.com/DavideCarvalho/nestjs-agent/pull/319) [`6b7de84`](https://github.com/DavideCarvalho/nestjs-agent/commit/6b7de84eca7dd094baf21a19be8144d8ae2409da) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The MCP server no longer lists or runs tools whose result is shown elsewhere (`presentation.result.kind === 'elsewhere'`), such as the generative-UI `ui__show_*`, `ui__show` and tree tools. They are `read` tools, so they used to be exposed. But all they do is push a component, an MCP client has no screen to show it on, and the model got nothing back.

## 0.3.1

### Patch Changes

- fix(deps): update dependency @modelcontextprotocol/sdk to v1.31.0 ([#297](https://github.com/DavideCarvalho/nestjs-agent/issues/297))

## 0.3.0

### Minor Changes

- [#267](https://github.com/DavideCarvalho/nestjs-agent/pull/267) [`43fa891`](https://github.com/DavideCarvalho/nestjs-agent/commit/43fa891a5a48bcf2130d01c4952b7b767d5dd502) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Confirmed writes — preview, signed single-use `confirmToken`, commit (port of adonis-agora-agent#233).

  `defineConfirmedTool(options, { prepare, preview, commit })` returns a functional tool whose human gate lives inside it, so the same write serves the chat loop and MCP (where an `action` tool has no approval channel): a call without `confirm` validates and previews without writing and returns a `confirmToken`; the same arguments plus `confirm: true` and the token commit. The token is an HMAC over the tool, actor, tenant, expiry and canonical arguments. A `ConfirmTokenStore` makes it single use — claimed right before `commit`, released if `commit` throws.

  - core: `defineConfirmedTool`, `withConfirmFields`, `ConfirmTokenError`, `signConfirmToken` / `verifyConfirmToken` / `hashConfirmToken` / `canonicalJson`, the `ConfirmTokenStore` SPI, `InMemoryConfirmTokenStore`, `AGENT_CONFIRM_TOKEN_STORE`, and `SchemaExtension` / `schemaExtensionOf` (a schema that is another schema plus a few JSON properties).
  - ai-sdk, mcp-server: a `SchemaExtension` schema is converted through its inner schema, so a Zod 3 tool wrapped by `withConfirmFields` shows the model its real shape plus `confirm` / `confirmToken`.
  - store-drizzle, store-mikro-orm: `DrizzleConfirmTokenStore` / `MikroOrmConfirmTokenStore` on a new `agent_confirm_token` table (created by `ensureAgentSchema`; MikroORM: also in `agentEntities()` / `agentManagedTables()`), bound to `AGENT_CONFIRM_TOKEN_STORE` by the store modules.
  - testing: `CONFIRM_TOKEN_STORE_CONTRACT`, the cases every store runs.

## 0.2.0

### Minor Changes

- [#263](https://github.com/DavideCarvalho/nestjs-agent/pull/263) [`3ed6542`](https://github.com/DavideCarvalho/nestjs-agent/commit/3ed654296e98ba93474c9edbf397ca10f1eb7c92) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `emptyRoles: 'deny'` — a ready-made closed roles gate, for apps where an empty roles list means "no one".

  **Upgrade note for core 0.27, which did not say it outright:** since 0.27 `DefaultRolesPolicy` treats an empty roles list as **open** — before, `[]` denied everyone. So `roles: []` on a tool, `defaultRoles: []`, and any computed `roles` that can come out empty went from reaching nobody to reaching every resolved actor, with no error and no warning.

  The default does not change — an empty list is still open, which is what makes `AgentModule.forRoot({ model })` a working chat. What is new is the switch to keep it closed:

  ```ts
  AgentModule.forRoot({ model, emptyRoles: "deny" }); // binds ClosedRolesPolicy
  AgentMcpServerModule.forRoot({ name, version, auth, emptyRoles: "deny" }); // the MCP surface alone

  new ClosedRolesPolicy(defaultRoles); // = new DefaultRolesPolicy(defaultRoles, { emptyRoles: 'deny' })
  closeEmptyRoles(policy); // close a policy you did not build
  new AuthzRolesPolicy(gate, { emptyRoles: "deny" }); // its role fallback
  ```

  Closed, the actor needs a role the tool declares (else one of `defaultRoles`): a tool with no `roles` and no default roles, or with an explicitly empty list, is neither offered nor invocable. `emptyRoles` on `AgentModule` is ignored when you pass your own `rolesPolicy`.

## 0.1.2

### Patch Changes

- [#219](https://github.com/DavideCarvalho/nestjs-agent/pull/219) [`50f76db`](https://github.com/DavideCarvalho/nestjs-agent/commit/50f76db3a7c283bdd576697578c449a4c5b7fcd2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Generative UI, reworked around the three packages apps already use.

  - **core**: the catalog moves to `@dudousxd/nestjs-agent-core/genui` (+ `/genui/builtins`), an isomorphic entry a browser can import (it bundles nothing server-only). `genuiTools` gains `resolveCatalog` (a per-request catalog consulted on every call and every turn's description) and `showTool` (one generic `ui__show` taking `{ component, props }`, for components no boot-time tool can name). `AiToolCtx.emitUi` is now always present — `createNoopEmitUi()` where there is no conversation — so tools call `ctx.emitUi(…)` without `?.`; genui tools no longer fall back to returning props. New `ToolHandler.describe(scope)` lets a tool vary its model-facing description/schema per turn; `definitionsFor` takes an optional `{ threadId, agentName }` scope and `LlmStepEnvelope` carries `threadId`.
  - **nestjs**: `@dudousxd/nestjs-agent/genui` — `AgentGenuiModule.forRoot({ catalog, mode, terminal, treeToolName, treeInstructions, roles, presentation, showTool, resolver })` / `forRootAsync({ imports, inject, useFactory, resolver })` registers the genui tools as agent tools; `GENUI_CATALOG` + `@InjectGenuiCatalog()`; `GenuiCatalogResolver` for per-tenant, versioned catalogs; `provideAgentTools` registers a factory-produced list of tools.
  - **react**: `<GenuiProvider registry catalog resolveComponent fallback treeRenderer>` at the root; `<GenerativeUI part />` and `useGenerativeUI(part)` read it (own props win), and `MessageItem` draws pushed components with no `renderUi` inside one. json-render is an option — `GenuiProvider` from `/genui/json-render` takes `jsonRender` (a json-render registry, or `true` to derive one) — instead of a `genui:tree` registry entry.
  - **mcp-server**: tools get a no-op `ctx.emitUi`.

  The never-published `@dudousxd/nestjs-agent-genui` package is gone; import from `@dudousxd/nestjs-agent-core/genui`.

## 0.1.1

### Patch Changes

- [#79](https://github.com/DavideCarvalho/nestjs-agent/pull/79) [`d950e64`](https://github.com/DavideCarvalho/nestjs-agent/commit/d950e6499cf1835a00bfa87a99c511874bd59f36) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Say what `BearerTokenActorResolver`'s token comparison actually guarantees: the contents are compared in time that does not depend on them, while the length check short-circuits by design.

## 0.1.0

### Minor Changes

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `@Mcp()` — expose a controller route you already wrote as an MCP tool.

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
  to _that_ surface, and replaying it at an internal route would both
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

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - An external MCP client can now reach this deployment's tools — through the gates a turn goes
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
