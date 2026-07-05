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
  basePath?: string;    // where the SPA is served. Default '/ai-gateway'
  apiBasePath?: string; // where the JSON/SSE API is mounted. Default '<basePath>/api'
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
