---
"@dudousxd/nestjs-agent-dashboard": minor
---

`AgentDashboardModule.forRoot()` gains a first-class `guards` option (`Type<CanActivate>[]`, stamped
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
