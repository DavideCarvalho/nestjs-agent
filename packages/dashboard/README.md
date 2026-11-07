# @dudousxd/nestjs-agent-dashboard

An embedded **AI-gateway governance console** for [`@dudousxd/nestjs-agent`](https://www.npmjs.com/package/@dudousxd/nestjs-agent) — the in-process analog of the Vercel AI Gateway dashboard, with governance already coupled (cost per model/actor, budgets, live tool-call/quota signals).

A bundled **React SPA** served by a **NestJS module**, mounted at its own route (default `/ai-gateway`). It reads historical spend/usage from the shared governance read-model and tails live activity off the `aviary:agent:*` diagnostics channel over SSE. Mirrors [`@dudousxd/nestjs-durable-dashboard`](https://www.npmjs.com/package/@dudousxd/nestjs-durable-dashboard).

## Install

```bash
pnpm add @dudousxd/nestjs-agent-dashboard
```

Peer deps: `@dudousxd/nestjs-agent-core`, `@nestjs/common`, `@nestjs/core`, `rxjs`.

## Mount it

Import `AgentDashboardModule.forRoot(...)` alongside your `@dudousxd/nestjs-agent` module (global), which must provide the `AGENT_GOVERNANCE_QUERIES` read-model (bound by a store adapter — `store-mikro-orm`, `store-drizzle`, or the in-memory testing adapter).

```ts
import { Module } from '@nestjs/common';
import { AgentModule } from '@dudousxd/nestjs-agent';
import { AgentDashboardModule } from '@dudousxd/nestjs-agent-dashboard';

@Module({
  imports: [
    AgentModule.forRoot({ /* ... */ }), // provides AGENT_GOVERNANCE_QUERIES (global)
    AgentDashboardModule.forRoot({
      basePath: '/ai-gateway',        // UI route (default)
      apiBasePath: '/api/ai-gateway', // JSON + SSE API (default: `<basePath>/api`)
    }),
  ],
})
export class AppModule {}
```

The controllers are **path-relative and guard-frontable** — front `basePath`/`apiBasePath` with your own auth guard/middleware.

### `forRoot` options

```ts
AgentDashboardModule.forRoot({
  basePath?: string;             // where the SPA is served. Default '/ai-gateway'
  apiBasePath?: string;          // where the JSON/SSE API is mounted. Default '<basePath>/api'
  decorators?: ClassDecorator[]; // who reaches it — see "Protecting the console" below
  routes?: boolean;              // false: mount it yourself
  imports?: DynamicModule['imports'];
  approvalActorRef?: (req) => string | undefined;
});
```

## Protecting the console

The console's routes are the app's to protect, with NestJS's own
[`@nestjs/authentication`](https://docs.nestjs.com/security/authentication) and
[`@nestjs/authorization`](https://docs.nestjs.com/security/authorization). Two ways:

1. **Mount it yourself** (`routes: false`), extending the exported controllers under your own path
   and decorators — the services keep running and the module exports what the controllers inject:

   ```ts
   AgentDashboardModule.forRoot({ routes: false, basePath: '/ops/ai', apiBasePath: '/ops/ai/api' });

   @Controller('ops/ai/api')
   @Can(ConsolePolicy, 'view')
   export class ConsoleApi extends AgentApiController {}

   @Controller('ops/ai')
   @Can(ConsolePolicy, 'view')
   export class ConsoleUi extends AgentUiController {}
   ```

2. **`decorators`**, applied to every controller the module mounts:

   ```ts
   AgentDashboardModule.forRoot({
     decorators: [UseGuards(AuthenticationGuard), Can(ConsolePolicy, 'view')],
   });
   ```

   A function works too, as a guard instance: `UseGuards({ canActivate: (ctx) => … })`.

**In production the console never boots open:** with neither `decorators` nor `routes: false`,
`forRoot` throws and says how to protect it. Outside production it mounts open.

The console has no sign-in of its own: the app's session (`@nestjs/authentication`) is what a
browser carries when it opens the console.

## JSON + SSE API

Mounted at `apiBasePath`:

| Method | Path | Response |
| ------ | ---- | -------- |
| `GET` | `/spend?from=YYYY-MM-DD&to=YYYY-MM-DD` | `{ byModel: ModelSpendRow[], byActor: ActorSpendRow[], trend: UsageTrendPoint[] }` (defaults to the last 30 days) |
| `GET` | `/tool-calls?limit=` | `ToolCallActivityRow[]` (default 50, max 200) |
| `GET` | `/threads?limit=` | `ThreadActivityRow[]` (default 50, max 200) |
| `GET` | `/<runs\|threads\|tool-calls\|approvals>-page?page=&limit=&where[…]=` | `GovernancePage<Row>` — `{ rows, total, page, pageSize }` |
| `GET` | `/runs/:runId` | `RunDetail` — the run, its thread's headline and its tool calls. `404`s on an unknown id |
| `GET` | `/threads/:threadId?messages=&runs=` | `ThreadDetail` — the thread, its lifetime usage rollup, newest runs and newest messages |
| `GET` | `/stream` | SSE of live `aviary:agent:*` events (`{ event, ts, payload }`) |

## SPA sections

- **Spend & usage** — headline $ + tokens, by-model donut + legend, daily trend (cost/tokens toggle), top threads by cost.
- **Models** — per-model requests / in+out tokens / cost / share.
- **Actors & budgets** — spend per acting ref; usage-vs-budget bar when a daily limit is known.
- **Runs & tools** — recent tool calls (with a denied/forbidden banner) and recent threads, both paged and filterable.
- **Reliability** — success/error rate, retries, p50+p95 duration, failures by error code, run/failure trend, and a paged recent-runs table.
- **Approvals** — the cross-thread HITL inbox, paged, reporting the full backlog (`N of M`) rather than a silent cap.
- **Tools** — per-tool volume, failure/rejection rate, and **both** latency percentiles (p50 next to p95 — p95 alone cannot tell an occasionally-hanging tool from a uniformly slow one).
- **Pricing** — the current per-model rate table plus an upsert form; renders its own "no pricing store bound" state when the host 501s.
- **Live** — the diagnostics SSE feed, newest-first, with quota/denied events flagged.

Rows are not dead ends: a run, a tool call, a thread and an approval all open a drill-down drawer over the table, and a thread's drawer deep-links to `#/reliability?threadId=…` for every run it made.

### How the SPA is wired

Worth knowing before changing it, because two of these are the reason the console behaves the way it does:

- **One container per section, each owning its own reads** (`src/app/containers/`). Sections that are not on screen issue no requests. The shell keeps exactly two data sources of its own, both because they must outlive the section being viewed: the SSE subscription, and the pending-approvals *count* behind the nav badge.
- **An error boundary per section** (`SectionBoundary`), so a failing read names itself and offers a retry instead of rendering an empty state that reads as "there is no data". Paged tables render their failures inline instead, next to the last rows that did load.
- **Freshness is `staleTime`, not an interval.** There is no `refetchInterval`; react-query's `refetchOnWindowFocus` is left on, and the per-query `STALE` values in `src/app/use-governance.ts` decide what that refetches. Aggregates are a minute stale, activity lists fifteen seconds, the approvals queue always.
- **Suspense reads waterfall.** Two `useSuspenseQuery` calls in one component serialise — the first throws and the second never runs. Reads of equal standing go through `useSuspenseQueries`; see the note in `use-governance.ts`.

## Typed client

For your own front-end, `@dudousxd/nestjs-agent-dashboard/client` exports `agentClient` (`spend`, `toolCalls`, `threads`, the `*Page` reads, `runDetail`, `threadDetail`, `streamEvents`) with the response types — dependency-free.

```ts
import { agentClient } from '@dudousxd/nestjs-agent-dashboard/client';

const overview = await agentClient.spend({ fromDay: '2026-06-01', toDay: '2026-06-30' });
```

## Build

`vite build && tsup && tsc -p tsconfig.client.json` — the SPA compiles to `dist/spa`, the NestJS server to `dist/server` (dual ESM + CJS with decorator metadata + `import.meta.url` shim), and the client types to `dist/client`. The bundled SPA ships in the package, so the UI controller serves it with no extra assets.

`preview.html` renders every section against mock data (no backend) for visual verification — including the drill-down drawers and the failure/loading states, which are otherwise the states a backend-less check can never reach.

### Charts

The trend charts and share donuts are [recharts](https://recharts.org), themed against the console's CSS
custom properties in `src/app/chart-ui.tsx`. Recharts is a real dependency of this package and is bundled
into `dist/spa` (its own `recharts-*.js` chunk); it is deliberately **not** reachable from the `./react`
entry, so a host that imports `<OpenAgentConsoleButton />` never pulls a charting library into its build.

## License

MIT © Davide Carvalho
