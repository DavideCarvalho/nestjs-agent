# nestjs-agent — governance console ("embedded AI gateway" view)

**Status:** designed 2026-07-05. Extends the shipped lib with a governance/observability surface — the in-process analog of the Vercel AI Gateway dashboard, with governance already coupled (cost per RBAC/persona/agent, budget per actor/tenant).

**Goal:** give the agent a governance view delivered **two ways**, exactly like `@dudousxd/nestjs-durable` does:
1. **Standalone** — a new `@dudousxd/nestjs-agent-dashboard` package: a bundled React SPA + NestJS module, mounted at its own route (default `/ai-gateway`), independent of Telescope. Mirrors `@dudousxd/nestjs-durable-dashboard`.
2. **Inside Telescope** — enrich the existing `@dudousxd/nestjs-agent-telescope` "Agent" tab to the same governance depth.

Both read from **one shared read-model** — no duplicated aggregation.

## Architecture

```
                 ┌─────────────────────────────┐
                 │  AgentGovernanceQueries SPI  │  (core: interface + token)
                 │  spendByModel / spendByActor │
                 │  usageTrend / recentToolCalls│
                 │  recentThreads               │
                 └──────────────┬──────────────┘
        implemented by store adapters (they own the tables)
     store-mikro-orm │ store-drizzle │ testing (in-memory)
                 ┌──────────────┴──────────────┐
        consumed by ▼                          ▼
   -dashboard (standalone SPA)        -telescope (Agent tab)
   + live diagnostics SSE feed        + live watcher (already there)
```

- **Historical / authoritative $ + usage** → the read-model (backed by `agent_token_usage` ⋈ `agent_model_pricing`). Survives restarts.
- **Live activity** (current runs, streaming tool calls, delegations, forbidden attempts) → the `aviary:agent:*` diagnostics channel (SSE), reused by both front-ends.

## 1. Shared read-model — `AgentGovernanceQueries` (core SPI)

A NEW optional SPI, separate from `AgentStore` (keeps the write/thread path focused). A store adapter implements both. Consumers inject `AGENT_GOVERNANCE_QUERIES = Symbol.for('@dudousxd/nestjs-agent:governance-queries')`.

```ts
/** Inclusive UTC day range, `YYYY-MM-DD`. */
export interface GovernanceRange { fromDay: string; toDay: string; }

export interface ModelSpendRow { modelId: string; requests: number; inputTokens: number; outputTokens: number; costUsd: number; }
export interface ActorSpendRow { actorRef: string; requests: number; totalTokens: number; costUsd: number; }
export interface UsageTrendPoint { day: string; totalTokens: number; costUsd: number; }
export interface ToolCallActivityRow { toolCallId: string; toolName: string; toolType: string; status: string; threadId: string; createdAt: string; }
export interface ThreadActivityRow { threadId: string; title: string; actorRef: string; messageCount: number; totalTokens: number; lastActivityAt: string; }

export interface AgentGovernanceQueries {
  spendByModel(range: GovernanceRange): Promise<ModelSpendRow[]>;
  spendByActor(range: GovernanceRange): Promise<ActorSpendRow[]>;
  usageTrend(range: GovernanceRange): Promise<UsageTrendPoint[]>;
  recentToolCalls(limit: number): Promise<ToolCallActivityRow[]>;
  recentThreads(limit: number): Promise<ThreadActivityRow[]>;
}
```

**Cost:** `costUsd = inputTokens/1e6 * inputPricePer1m + outputTokens/1e6 * outputPricePer1m`, joined on the *current* pricing row per `modelId` (`AgentModelPricing.isCurrent`). Unknown model → cost 0 (usage still shown).

Implementations:
- **store-mikro-orm** — QueryBuilder GROUP BY over `agent_token_usage` joined to `agent_model_pricing`; DB-tested via `*.db.spec.ts`.
- **store-drizzle** — same aggregation on the drizzle schema.
- **testing (in-memory)** — aggregate the in-memory usage rows; optional pricing map (default empty → cost 0). Feeds the demo + unit tests.

## 2. Standalone `@dudousxd/nestjs-agent-dashboard`

Mirrors `@dudousxd/nestjs-durable-dashboard` faithfully. Structure:

- `src/server/` — `AgentDashboardModule.forRoot({ basePath?, apiBasePath? })` (default `basePath: '/ai-gateway'`, `apiBasePath: '<basePath>/api'`), `agent-ui.controller.ts` (serves the bundled SPA from `dist/spa`, index no-cache + immutable hashed assets, base-rewrite), `agent-api.controller.ts` (JSON API + SSE), `dashboard.service.ts` (injects `AGENT_GOVERNANCE_QUERIES` + subscribes the diagnostics channel). Routes mounted via `RouterModule.register`, path-relative controllers, guard-frontable.
- `src/app/` — Vite React SPA (React 19 to match the aviary-agent ecosystem). Tailwind. Sections below.
- `src/client/` — a typed API client (`./client` export) + pure data-shaping helpers (unit-tested).
- Build: `vite build && tsup && tsc -p tsconfig.client.json` (SPA → `dist/spa`, server dual ESM+CJS via the shared decorator tsup config, importMetaUrlShim). Tokens `Symbol.for`. `forRoot` returns a dynamic module.

**JSON API** (SPA fetches):
- `GET <api>/spend?from=&to=` → `{ byModel, byActor, trend }`
- `GET <api>/tool-calls?limit=` → `ToolCallActivityRow[]`
- `GET <api>/threads?limit=` → `ThreadActivityRow[]`
- `GET <api>/stream` → SSE of live `aviary:agent:*` events

**SPA sections** (the gateway console):
- **Spend & usage** (headline) — total $ + tokens for the range; by-model donut/table; day trend.
- **Models** — per-model requests / in+out tokens / cost / share.
- **Actors & budgets** — spend by actor/tenant; usage vs configured daily limit when known.
- **Runs & tools** — recent tool calls (status), recent threads, denied/forbidden signal.
- **Live** — the diagnostics SSE feed.

Keep chart deps minimal (inline SVG / CSS bars or one lightweight lib); everything self-contained in the bundle.

## 3. Telescope enrichment (`-telescope`)

The existing "Agent" dashboard (today: Runs/Tokens stats + Tools) gains spend/models/budgets sections fed by the **same** `AGENT_GOVERNANCE_QUERIES` (via a new data provider that injects it), not the ephemeral event storage. Live tool-call/run panels keep using the watcher.

## Global constraints

- Function declarations (not arrow consts); no `Co-Authored-By`; pinned exact versions (no `^`/`~`); `exactOptionalPropertyTypes` conditional-spread idiom; DI tokens `Symbol.for`; descriptive names; user-facing copy in English; avoid `as`/`any`/`unknown` (narrow at boundaries).
- No file crosses ~1000 lines; decompose SPA into focused components.
- Adapters stay ORM-portable; the read-model is the only new store surface.

## Execution — parallel waves

Serial spine first (defines the shared contract, done by the orchestrator): the `AgentGovernanceQueries` SPI + token in core. Then three independent, disjoint-package agents run in parallel (they only WRITE files — no `pnpm install`/`build`/`test`; the orchestrator does one central install + build + typecheck + test + biome pass and fixes integration inline):

- **Agent A — read-model impls:** `store-mikro-orm` + `store-drizzle` + `testing` (in-memory) implementations + their `*.db.spec.ts` / unit specs.
- **Agent B — standalone `-dashboard`:** whole package (build config + server + SPA + client), mirroring `../nestjs-durable/packages/dashboard`.
- **Agent C — telescope enrichment:** a governance data provider + enriched dashboard sections in `-telescope`.
