# @dudousxd/nestjs-agent-dashboard

## 0.4.1

### Patch Changes

- [#5](https://github.com/DavideCarvalho/nestjs-agent/pull/5) [`619a097`](https://github.com/DavideCarvalho/nestjs-agent/commit/619a09771830db31739594813b0b937b844939f6) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Guards with dependencies now resolve: guard classes and the host's `imports` are threaded into
  `AgentApiModule` (the API controller's HOST module) and registered as providers on both host
  modules — enhancers DI-instantiate from their controller's own module, never a parent, so the
  previous wiring failed boot with "Nest can't resolve dependencies ... in the AgentApiModule
  context" for any guard that injects something.

## 0.4.0

### Minor Changes

- [#3](https://github.com/DavideCarvalho/nestjs-agent/pull/3) [`abb32bc`](https://github.com/DavideCarvalho/nestjs-agent/commit/abb32bc0396c65a59ee2b92a1a8b07d772215e31) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `AgentDashboardModule.forRoot()` gains a first-class `guards` option (`Type<CanActivate>[]`, stamped
  on both the SPA and API controllers via `@nestjs/common`'s own `@UseGuards` metadata — REPLACE
  semantics) plus an `imports` passthrough for the guards' own dependencies, replacing the "front the
  routes with your own guard" doc note with a real mechanism. A new `agentDashboardMountPaths()` helper
  returns the four route roots (UI + API, each with a `{*splat}`) a host's `setGlobalPrefix('api',
{ exclude })` needs to keep the dashboard resolving outside the prefix — mirrors
  `telescopeMountPaths()`.

  Every actor-scoped API row (`spend().byActor`, `GET top-threads`, `GET threads`) now carries an
  additive `actorLabel: string | null`, resolved via the optionally-injected `AGENT_ACTOR_DIRECTORY`
  (batched into one `resolveDisplay()` call per response) — `null` on every row when nothing is bound,
  so existing consumers keep working unchanged. `ActorsSection` renders the label when present.

  The dashboard API gains pricing CRUD backed by the optionally-injected `AGENT_PRICING_STORE`:
  `GET <api>/pricing` (list current prices) and `POST <api>/pricing` (upsert a model's price, minimally
  validated), both 501ing with a clear message when no pricing store is bound. A new "Pricing" tab in
  the SPA lists current rates and offers a minimal upsert form, replacing the hand-written pricing
  controller + curation UI consumers otherwise maintain themselves.

## 0.3.1

### Patch Changes

- [`60dcc7d`](https://github.com/DavideCarvalho/nestjs-agent/commit/60dcc7db3764a7d60cb6e4d586f1c0fe7b05ee04) - Governance queries: add `spendByThread(range, limit)` (top threads by cost) and
  `ActorSpendRow.threadCount`. Cost is now priced through the injected
  `AGENT_PRICING_STORE` instead of reading `agent_model_pricing` directly, and both
  store modules accept a `pricingStore` option so a host can bind its own pricing
  table as the single source of cost truth for every governance surface. Default
  behavior (the store's own pricing table) is unchanged.

  The dashboard (`/ai-gateway`) and the Telescope Agent tab gain a "Top threads by
  cost" panel fed by `spendByThread`.
