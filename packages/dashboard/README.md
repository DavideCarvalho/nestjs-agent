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
  guards?: Type<CanActivate>[];  // bring-your-own auth — see "Console auth" below
  dashboardAuth?: DashboardAuthOptions; // signed-cookie gate (Mode A session / Mode B login) — see "Console auth" below
  imports?: DynamicModule['imports'];
  approvalActorRef?: (req) => string | undefined;
});
```

## Console auth

The console has no auth of its own by default — pick one of three postures, or combine them:

| Posture | When to use | Setup |
| ------- | ----------- | ----- |
| **Open** (default) | Local dev only. Never mount this way in production. | Omit both `guards` and `dashboardAuth`. |
| **`guards`** | You already have auth the console can reuse — an existing cookie-session guard, an SSO/OIDC session, a header your reverse proxy injects. | Pass guard classes; see below. |
| **`dashboardAuth`** | You have no ready-made guard for the console — e.g. your app authenticates with a header-only Bearer token a browser navigation can't attach — and want a protected console without building a whole `CanActivate`. Two modes: `session` (host mints the cookie from its own auth) or `login` (built-in login screen). | Pass `{ secret, session }` and/or `{ secret, login }`; see below. |

Both `guards` and `dashboardAuth` can be set together — **AND semantics**: a request must pass BOTH. `dashboardAuth`'s own gate runs first; a denied request never reaches your `guards`.

### Option A — `guards` (bring your own)

Front `basePath`/`apiBasePath` with a guard that reads YOUR app's session. A full-page navigation to `basePath` carries only cookies (never an `Authorization` header), so the guard must be able to authenticate from a cookie:

```ts
import { CanActivate, ExecutionContext, Injectable, Module } from '@nestjs/common';
import { AgentDashboardModule } from '@dudousxd/nestjs-agent-dashboard';

@Injectable()
class ConsoleSessionGuard implements CanActivate {
  constructor(private readonly sessions: SessionService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest();
    const session = await this.sessions.verify(request.cookies?.appSession);
    return session?.roles.includes('admin') ?? false;
  }
}

@Module({
  imports: [
    AgentDashboardModule.forRoot({
      guards: [ConsoleSessionGuard],
      imports: [SessionModule], // resolves ConsoleSessionGuard's own dependencies
    }),
  ],
})
export class AppModule {}
```

### Option B — `dashboardAuth` (signed session cookie)

Gates the console behind a stateless, signed session cookie (HMAC-SHA256, `node:crypto` only — no JWT dependency, no session store, mirrors `@dudousxd/nestjs-telescope`'s `dashboardAuth`). Two ways to mint that cookie — **Mode A** (`session`) and **Mode B** (`login`). At least one is required, or `forRoot`/`forRootAsync` throws at boot (an un-mintable gate is a boot error, not a silently-open console); you can also configure both together (e.g. Mode A for normal use, Mode B as a break-glass fallback). An unauthenticated API call always gets `401`, regardless of mode.

#### Mode A — `session` (the host mints the cookie)

Your host app already has its own auth (SSO/OIDC/whatever) — no need to teach this library a second credential. The host frontend, carrying that auth, `POST`s to `<basePath>/auth/session`; your `session` hook validates the raw request and returns the session user, or `null` to deny (`401`). No credential this library understands ever exists.

```ts
AgentDashboardModule.forRoot({
  dashboardAuth: {
    secret: process.env.AI_GATEWAY_AUTH_SECRET, // REQUIRED — 32+ bytes recommended. Missing => boot error.
    session: async (request) => {
      const user = await sessions.verifyFromCookie(request); // read YOUR app's own session
      return user ? { id: user.id, name: user.name, roles: user.roles } : null; // null => 401
    },
  },
});
```

Have your host frontend call `POST <basePath>/auth/session` once it knows the visitor is signed in — no body this library reads. Success is `204` with the `Set-Cookie`; a denial is `401` and no cookie is set. An unauthenticated PAGE navigation under Mode-A-only has nowhere to redirect to (there's no login form) — it's served a small, static instruction page at `<basePath>/auth/session-required` instead, telling the visitor to sign in through the host app and reload.

##### `unauthenticatedPage` — render that instruction page yourself

The built-in page cannot know who hosts the console, so it can only say "open this console from your application" in the abstract — it can't name your launcher, link to it, or look like the rest of your product. Pass `unauthenticatedPage` and the whole response is yours:

```ts
AgentDashboardModule.forRoot({
  dashboardAuth: {
    secret: process.env.AGENT_DASHBOARD_SECRET,
    session: (request) => resolveAdmin(request),
    unauthenticatedPage: ({ request, response, basePath }) => {
      // `request`/`response` are your platform's own objects (Express here). Render however you
      // already render — a template engine, @dudousxd/nestjs-inertia, a plain string.
      (response as Response).status(401).render('console-locked', { returnTo: basePath });
    },
  },
});
```

The hook **owns** the response: it must write AND end it. It replaces what `<basePath>/auth/session-required` *contains*, not the flow that reaches it — a denied navigation is still redirected there.

It cannot open the console: it only ever runs on a request that has already been denied. If it throws, or returns without writing, the library logs one warning and falls back to the built-in page, so a broken page can't hang the request or turn a denial into a `500`. It is also not a mode — `unauthenticatedPage` alone still fails boot on the "at least one of `session` or `login`" check.

Under Mode B this route stays `404`: there is no session-required page to customise, because a denied navigation goes to the login form instead. To ship your own **login** UI, combine Mode A with this hook and `POST <basePath>/auth/session` from your page — that mint endpoint is the supported primitive for it.

#### Mode B — `login` (built-in login screen)

No host frontend/IdP to lean on — the console serves its own small, dependency-free, server-rendered login page. An unauthenticated page visit is redirected (302) to a built-in login form at `<basePath>/auth/login`.

```ts
AgentDashboardModule.forRoot({
  dashboardAuth: {
    secret: process.env.AI_GATEWAY_AUTH_SECRET, // REQUIRED — 32+ bytes recommended. Missing => boot error.
    ttl: '8h',                                  // optional, default '8h'; sliding renewal past 50% TTL
    login: async (username, password) => {
      const user = await users.verify(username, password);
      return user ? { id: user.id, name: user.name, roles: user.roles } : null; // null => generic failure
    },
  },
});
```

Open `/ai-gateway`, enter the credentials, and you're in. Bad credentials get a **uniform** redirect back to the login page — the response is identical for an unknown user and a wrong password, so the endpoint never reveals which one was wrong. `POST <basePath>/auth/logout` clears the cookie (redirecting back to the login form, or — Mode-A-only — to the `session-required` instruction page above).

Only `username` is required (non-empty) — the password is passed through to `login` verbatim, including empty, so a host that authenticates by username/email alone (password deliberately ignored) can use the built-in screen unmodified; the hook owns whether an empty password is accepted or rejected.

Need the `login` hook to reach a DB (e.g. an `EntityManager`)? Use `forRootAsync` — `basePath`/`apiBasePath`/`guards` stay static (needed at module-build time for routing), only the auth config is resolved through DI:

```ts
AgentDashboardModule.forRootAsync({
  imports: [DatabaseModule],
  inject: [EntityManager],
  useDashboardAuth: (em: EntityManager) => ({
    secret: process.env.AI_GATEWAY_AUTH_SECRET,
    login: async (username, password) => {
      const admin = await em.findOne(AdminUser, { username });
      return admin && (await admin.verifyPassword(password))
        ? { id: admin.id, name: admin.name, roles: ['admin'] }
        : null;
    },
  }),
});
```

#### Session lifetime: `ttl`, sliding renewal, and `revalidate`

Any request carrying a valid cookie past 50% of its `ttl` gets a freshly re-signed one, so an active tab never expires mid-use. `revalidate?: (session) => boolean | Promise<boolean>` hooks into that same sliding-renewal path — a chance to re-check a *live* session (e.g. "is this user still active?") before the fresh cookie ships, so a deactivated or demoted operator loses access instead of riding a self-renewing cookie for as long as the tab stays open. Return `false` (or throw) to revoke: the cookie is cleared and the request denied, the same treatment as an absent cookie. It runs at most once per `ttl/2` per cookie generation, per in-flight request — concurrent requests still carrying the same not-yet-renewed cookie each invoke it (a page load firing several parallel API calls can trigger several calls before the refreshed cookie lands), so size it for occasional concurrent invocations, not a strict once-per-session cap. `revalidate` alone can't mint a session — it doesn't count toward the `session`/`login` "at least one" requirement.

```ts
AgentDashboardModule.forRoot({
  dashboardAuth: {
    secret: process.env.AI_GATEWAY_AUTH_SECRET,
    session: async (request) => /* ... */,
    revalidate: async (session) => (await users.findActive(session.id)) !== null,
  },
});
```

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
