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

The controllers are **path-relative**; who reaches them is `authorize` (see below).

### `forRoot` options

```ts
AgentDashboardModule.forRoot({
  basePath?: string;             // where the SPA is served. Default '/ai-gateway'
  apiBasePath?: string;          // where the JSON/SSE API is mounted. Default '<basePath>/api'
  authorize?: ConsoleAuthorize;  // who reaches it — see "Protecting the console" below
  decorators?: ClassDecorator[]; // applied to every mounted controller, before `authorize`
  routes?: boolean;              // false: mount it yourself
  imports?: DynamicModule['imports'];
  approvalActorRef?: (req) => string | undefined;
});
```

## Protecting the console

`authorize` decides who reaches the console: the SPA and every API and SSE route. It runs after any
`decorators` you pass, so an authentication guard there has already set `request.user`.

```ts
AgentDashboardModule.forRoot({
  decorators: [UseGuards(AuthenticationGuard)],
  authorize: (ctx) => ctx.switchToHttp().getRequest().user?.isAdmin === true,
});
```

`authorize` takes any of these forms:

```ts
// 1. An inline function.
authorize: (ctx) => ctx.switchToHttp().getRequest().user?.isAdmin === true,

// 2. A class: an @Injectable() ConsoleAuthorizer (constructor injection works).
authorize: ConsoleAccess,

// 3. A lazy import of that class.
authorize: () => import('./console-access.js'),

// 4. A policy from @nestjs/authorization: policy[ability](user).
authorize: { policy: ConsolePolicy, ability: 'view' },

// 5. A gate ability name from @dudousxd/nestjs-authz (needs its AuthzModule).
authorize: 'console.agent',
```

```ts
import { Injectable, type ExecutionContext } from '@nestjs/common';
import type { ConsoleAuthorizer } from '@dudousxd/nestjs-agent-dashboard';

@Injectable()
export default class ConsoleAccess implements ConsoleAuthorizer {
  constructor(private readonly audit: AuditService) {}

  async authorize(ctx: ExecutionContext) {
    const user = ctx.switchToHttp().getRequest().user;
    if (!user) return { redirectTo: '/login' };
    return user.roles.includes('ops');
  }
}
```

What `authorize` returns:

| Result | API call | Page navigation |
|---|---|---|
| `true` / `{ allowed: true }` | allowed | allowed |
| `false` / `{ allowed: false }` | `403 { error: 'forbidden' }` | `403` access-denied page |
| `{ allowed: false, reason: 'unauthenticated' }` | `401 { error: 'unauthenticated' }` | `401` sign-in-required page |
| `{ redirectTo: '/login' }` | `401 { error: 'unauthenticated', redirectTo }` | `302` to `redirectTo` |
| throws | `403` | `403` |

The SPA follows a `redirectTo` it gets from the API and shows an access-denied screen on a `403`.

### A bearer token

`authorizeByToken` allows a request whose `Authorization: Bearer <token>` header matches:

```ts
import { authorizeByToken } from '@dudousxd/nestjs-agent-dashboard';

AgentDashboardModule.forRoot({
  authorize: authorizeByToken({ token: process.env.CONSOLE_TOKEN }),
});
```

Only the header counts (no query string). An empty token throws when the module is configured.

### Without `authorize`

- Outside production (`NODE_ENV !== 'production'`) the console is open.
- In production every request answers `403 { error: 'forbidden' }`.
- Either way, one warning is logged at boot telling you to set `authorize`, also with `routes: false`
  (`UseConsoleAuthorize()` applies the same production `403`).

`decorators` alone do not change this: set `authorize`.

### Mounting it yourself

With `routes: false` the module mounts nothing; extend the exported controllers under your own path,
and apply the module's `authorize` with `UseConsoleAuthorize()`. Put it above your authentication
decorators: Nest applies class decorators bottom-up, so the one written higher runs later.

```ts
AgentDashboardModule.forRoot({
  routes: false,
  basePath: '/ops/ai',
  apiBasePath: '/ops/ai/api',
  authorize: { policy: ConsolePolicy, ability: 'view' },
});

@Controller('ops/ai/api')
@UseConsoleAuthorize() // above the auth guard: class decorators apply bottom-up
@UseGuards(AuthenticationGuard)
export class ConsoleApi extends AgentApiController {}

@Controller('ops/ai')
@UseConsoleAuthorize() // above the auth guard: class decorators apply bottom-up
@UseGuards(AuthenticationGuard)
export class ConsoleUi extends AgentUiController {}
```

The console has no sign-in of its own: the app's session is what a browser carries when it opens
the console, and `authorize` can send it to your sign-in with `{ redirectTo }`.

### Migrating from the production boot refusal

The console no longer refuses to boot in production without `decorators`; set `authorize` instead.

```ts
// Before
AgentDashboardModule.forRoot({
  decorators: [UseGuards(AuthenticationGuard), Can(ConsolePolicy, 'view')],
});

// After
AgentDashboardModule.forRoot({
  decorators: [UseGuards(AuthenticationGuard)],
  authorize: { policy: ConsolePolicy, ability: 'view' },
});
```

A `decorators` list that still decides access (a `Can()`, a guard that denies) keeps working, but
without `authorize` the console answers `403` to every request in production.

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
into `dist/spa` (its own `recharts-*.js` chunk); it is not reachable from the `./client` entry, so
a frontend that imports the typed client never pulls a charting library into its build.

## License

MIT © Davide Carvalho
