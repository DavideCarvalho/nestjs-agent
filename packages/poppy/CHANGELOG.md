# @dudousxd/nestjs-agent-poppy

## 2.0.0

### Major Changes

- [#426](https://github.com/DavideCarvalho/nestjs-agent/pull/426) [`93179c1`](https://github.com/DavideCarvalho/nestjs-agent/commit/93179c121f7fe1b38dc57267958c3e82ef490270) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Require Node.js 24 or newer: `engines.node` is now `>=24` (was `>=20`, `>=22`, or unset). CI tests on Node 24 and 26. Upgrade Node, then the packages.

  Removed, with no alias (see the docs' Upgrading page):

  - `@dudousxd/nestjs-agent-core`: `AGENT_QUOTA_STORE` (nothing has bound it since the quota rework; use `AGENT_QUOTA_PROVIDER`), `announcedPoppyIssuer` (use `globalPoppyIssuer`, the same function), and `assertNoLegacyKitOptions` with the migration errors `genuiSandboxKit()`, `writeSandboxKitDocs()` and `defineSandbox()` threw for options removed in 0.53.
  - `@dudousxd/nestjs-agent`: `AgentService.renameThread()`. Use `updateThread(actor, threadId, { title })`.
  - `@dudousxd/nestjs-agent-mcp-server`: the `announcedPoppyIssuer` re-export. It now re-exports `globalPoppyIssuer`.
  - `@dudousxd/nestjs-agent-telescope`: `agentToolsProvider()`, the ephemeral `agent.tools` table the extension no longer registered. Use `agentRecentToolCallsTableProvider()`.

  `@dudousxd/nestjs-agent` and `@dudousxd/nestjs-agent-opencode` inject the run gateway by the `RunGateway` class instead of the deprecated `RUN_GATEWAY` alias from `@dudousxd/nestjs-durable`. It is the same DI token in every `@dudousxd/nestjs-durable` they support.

## 1.0.1

### Patch Changes

- [#413](https://github.com/DavideCarvalho/nestjs-agent/pull/413) [`0bff991`](https://github.com/DavideCarvalho/nestjs-agent/commit/0bff991992ab609482d693cd84d1db6ca34b6d5f) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Docs: the boot warning about both a `rolesPolicy` option and a bound `AGENT_ROLES_POLICY` no longer names the removed `AgentAuthzModule` (ability checks are `@Can()` from `@nestjs/authorization`). `CanAnyone()`'s doc names `decorators`, not the removed `guards`. The dashboard README no longer refers to the removed `./react` entry, the Poppy README says its 1.0 is not a stability promise, and `transport-redis` ships a README.

## 1.0.0

### Minor Changes

- [#406](https://github.com/DavideCarvalho/nestjs-agent/pull/406) [`2163635`](https://github.com/DavideCarvalho/nestjs-agent/commit/21636350636930791f99d8decc4e0056b30e4f33) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `decorators: ClassDecorator[]` on every module that mounts controllers — `AgentModule` (its routes, the protocol adapters' and the engine's), `AgentDashboardModule`, `AgentChannelsModule`, `AgentPoppyConnectionsModule`, `AgentMediaAttachmentsModule` and `AgentMcpServerModule` (added after the agent's own guard and filter) — the ecosystem's convention, like `@nestjs/mcp`'s: decide who reaches the routes with the official tools, e.g. `[UseGuards(AuthenticationGuard), Can(AgentPolicy, 'chat')]`. They are applied to a subclass of each controller made for that registration (`withControllerDecorators` in core), so nothing sticks to the shared classes or leaks into another registration. Without them the routes stay open to `@nestjs/authorization`'s deny-by-default guard (`CanAnyone()`), and a `@Can()` passed here is still checked.

- [#406](https://github.com/DavideCarvalho/nestjs-agent/pull/406) [`2163635`](https://github.com/DavideCarvalho/nestjs-agent/commit/21636350636930791f99d8decc4e0056b30e4f33) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Tool authorization is NestJS's `@nestjs/authorization`. A tool's `@Can()` — on an `@AiTool` class or its `execute()`, on an `@AgentFunction()` method, on a route exposed with `@Mcp()` — is read off the decorator: an ability that needs only the user decides whether the model (or an MCP client) is offered the tool, asked of `AuthorizationService` for the turn's actor, and the guard checks every call; an ability whose arguments read the call is the guard's alone. `staticCanArgs(...)` marks fixed arguments so they gate the offer too.

  Breaking:

  - `ability: string` is gone from `ToolSpec`, `@AiTool`, `@Mcp()`, `@Agent({ handoff })`, `genuiTools` / `AgentGenuiModule` and the MCP-client and Poppy options. Tools with nothing to decorate take `can: [{ policy, ability }]` instead; `@Mcp({ ability })` refuses the boot and points at `@Can()`.
  - `@dudousxd/nestjs-agent-authz` is removed (`AgentAuthzModule`, `AuthzRolesPolicy`): use `@nestjs/authorization`'s `AuthorizationModule` and `@Can()`.
  - A tool that requires an ability with no `AuthorizationModule` imported reaches nobody (fail closed); an `@AiTool` whose `@Can()` reads the call refuses the boot without `AiModule`, since only its guard could check it.

  `AuthorizationModule`'s global guard denies whatever declares no `@Can()`. The library's own controllers, and the tools it governs (`@AiTool`, this library's `@AgentFunction()`), carry `CanAnyone()` (`Can.Anyone()`'s mark, without the dependency): the actor resolver, `guards` and the roles policy decide who reaches them, and a `@Can()` they declare is still checked.

### Patch Changes

- [#406](https://github.com/DavideCarvalho/nestjs-agent/pull/406) [`2163635`](https://github.com/DavideCarvalho/nestjs-agent/commit/21636350636930791f99d8decc4e0056b30e4f33) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix packages that could be published without files their `exports` point to. The two tsup passes (ESM, CJS) no longer each clean `dist/` while running at the same time; `dist/` is cleaned once before the build. A new `check:exports` step (also `prepack`) fails the release if any `exports`/`main`/`types` path is missing.

- Updated dependencies [[`2163635`](https://github.com/DavideCarvalho/nestjs-agent/commit/21636350636930791f99d8decc4e0056b30e4f33), [`2163635`](https://github.com/DavideCarvalho/nestjs-agent/commit/21636350636930791f99d8decc4e0056b30e4f33), [`2163635`](https://github.com/DavideCarvalho/nestjs-agent/commit/21636350636930791f99d8decc4e0056b30e4f33), [`2163635`](https://github.com/DavideCarvalho/nestjs-agent/commit/21636350636930791f99d8decc4e0056b30e4f33), [`2163635`](https://github.com/DavideCarvalho/nestjs-agent/commit/21636350636930791f99d8decc4e0056b30e4f33), [`2163635`](https://github.com/DavideCarvalho/nestjs-agent/commit/21636350636930791f99d8decc4e0056b30e4f33), [`2163635`](https://github.com/DavideCarvalho/nestjs-agent/commit/21636350636930791f99d8decc4e0056b30e4f33), [`2163635`](https://github.com/DavideCarvalho/nestjs-agent/commit/21636350636930791f99d8decc4e0056b30e4f33), [`2163635`](https://github.com/DavideCarvalho/nestjs-agent/commit/21636350636930791f99d8decc4e0056b30e4f33)]:
  - @dudousxd/nestjs-agent@2.0.0

## 0.1.1

### Patch Changes

- [#379](https://github.com/DavideCarvalho/nestjs-agent/pull/379) [`ac24f24`](https://github.com/DavideCarvalho/nestjs-agent/commit/ac24f24bb12e580318cdc442de3ace34bfe4608b) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A Poppy conversation started signed out now continues after the User signs in. The step-up turn used to fail with `thread belongs to another actor` (the thread belonged to the signed-out `poppy:<hash>` actor, the turn ran as the account) and the personal agent got "Sorry, something went wrong". When the thread's owner is not the turn's actor, the turn runs in a new thread, told the conversation's earlier messages as a transcript. `PersonalAgentTurnService` may implement `threadOwner` (`AgentService` does).

## 0.1.0

### Minor Changes

- [#377](https://github.com/DavideCarvalho/nestjs-agent/pull/377) [`25ccb40`](https://github.com/DavideCarvalho/nestjs-agent/commit/25ccb408fd03cd284036503b8443b7ea6b6694aa) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - New package (experimental — tracks Personal Agent Protocol "Poppy" Draft 0.1; it will change, possibly in breaking ways, outside semver majors while the spec is a draft):

  - **`AgentPoppyModule`** — the company-side conversation endpoint (§7): `POST {path}`, `/{id}/messages`, `GET /{id}/events` (cursor, `wait`, SSE with `Last-Event-ID` and `text-delta`), `/{id}/handoff`, `/{id}/close`; Direct Conversations; idempotent message ids (`message_id_conflict`); `authorization` events (`sign_in_required` / `insufficient_scope`) for tools behind a scope the token lacks; actions (blocking or independent proposals) approved by the token's scopes, returned as `data.actions` and always told in words (`formatAction`); a durable event log that is the turn queue, with a reader lease and recovery. Session Tokens are verified by the resolver in `Symbol.for('@adonis-agora/poppy:authenticate')` (the same contract as `@adonis-agora/authkit-server`) or `authenticate`; `501` without one. With `baseUrl`, the endpoint is announced in `Symbol.for('@adonis-agora/poppy:endpoints')`. `PoppyConversations` drives the company side (a person joining, handoff, `user_requested`).
  - **`AgentPoppyConnectionsModule`** — the app's agent acting at other Poppy companies for its users: identity routes (`agent.json`, `jwks.json`, `logo.svg`, `oauth/callback`), connect pages (Direct with PKCE + `iss`, Mediated, Device), connections sealed at rest (AES-256-GCM, `secret`), an allow-list of companies (default none), and the tools `poppy_companies`, `poppy_connect` (a link card valid as long as the link), `poppy_tools`, `poppy_read`, `poppy_ask` (narrowed to read scopes), `poppy_write` (two-step company tools committed on confirm), `poppy_request`, `poppy_disconnect`. A completed sign-in decides the parked connect call; under independent approvals the conversation continues with a new turn, delivered to the text channel it came from.
  - **`@dudousxd/nestjs-agent-poppy/client`** and the **`poppy-agent`** CLI — the reference Personal Agent, the same client (same API and conformance suite) as `@adonis-agora/agent/poppy-client`.
  - `runPersonalAgentTurn` — run a personal agent's turn over `AgentService`.
