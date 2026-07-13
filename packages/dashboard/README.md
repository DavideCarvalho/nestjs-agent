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
  dashboardAuth?: DashboardAuthOptions; // built-in login screen — see "Console auth" below
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
| **`dashboardAuth`** | You have no ready-made guard for the console — e.g. your app authenticates with a header-only Bearer token a browser navigation can't attach — and want the simplest path to a protected console with zero SSO setup. | Pass `{ secret, login }`; see below. |

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

### Option B — `dashboardAuth` (built-in login screen)

Gates the console behind a stateless, signed session cookie (HMAC-SHA256, `node:crypto` only — no JWT dependency, no session store, mirrors `@dudousxd/nestjs-telescope`'s `dashboardAuth`). An unauthenticated page visit is redirected (302) to a built-in login form at `<basePath>/auth/login`; an unauthenticated API call gets `401`.

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

Open `/ai-gateway`, enter the credentials, and you're in. Bad credentials get a **uniform** redirect back to the login page — the response is identical for an unknown user and a wrong password, so the endpoint never reveals which one was wrong. `POST <basePath>/auth/logout` clears the cookie.

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

## JSON + SSE API

Mounted at `apiBasePath`:

| Method | Path | Response |
| ------ | ---- | -------- |
| `GET` | `/spend?from=YYYY-MM-DD&to=YYYY-MM-DD` | `{ byModel: ModelSpendRow[], byActor: ActorSpendRow[], trend: UsageTrendPoint[] }` (defaults to the last 30 days) |
| `GET` | `/tool-calls?limit=` | `ToolCallActivityRow[]` (default 50, max 200) |
| `GET` | `/threads?limit=` | `ThreadActivityRow[]` (default 50, max 200) |
| `GET` | `/stream` | SSE of live `aviary:agent:*` events (`{ event, ts, payload }`) |

## SPA sections

- **Spend & usage** — headline $ + tokens, by-model donut + legend, daily trend (cost/tokens toggle).
- **Models** — per-model requests / in+out tokens / cost / share.
- **Actors & budgets** — spend per acting ref; usage-vs-budget bar when a daily limit is known.
- **Runs & tools** — recent tool calls (with a denied/forbidden banner) and recent threads.
- **Live** — the diagnostics SSE feed, newest-first, with quota/denied events flagged.

## Typed client

For your own front-end, `@dudousxd/nestjs-agent-dashboard/client` exports `agentClient` (`spend`, `toolCalls`, `threads`, `streamEvents`) with the response types — dependency-free.

```ts
import { agentClient } from '@dudousxd/nestjs-agent-dashboard/client';

const overview = await agentClient.spend({ fromDay: '2026-06-01', toDay: '2026-06-30' });
```

## Build

`vite build && tsup && tsc -p tsconfig.client.json` — the SPA compiles to `dist/spa`, the NestJS server to `dist/server` (dual ESM + CJS with decorator metadata + `import.meta.url` shim), and the client types to `dist/client`. The bundled SPA ships in the package, so the UI controller serves it with no extra assets.

`preview.html` renders every section against mock data (no backend) for visual verification.

## License

MIT © Davide Carvalho
