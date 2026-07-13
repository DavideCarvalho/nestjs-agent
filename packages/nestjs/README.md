# `@dudousxd/nestjs-agent`

> 🪺 Part of the [Aviary](https://davidecarvalho.github.io/aviary) — plug-n-play, fully-configurable NestJS libraries.

A **governed, durable-backed AI agent** for NestJS: chat + tool-calling + role/persona governance +
token quota + cost tracking + human-in-the-loop approval + resumable streaming + multi-agent
delegation. The agent turn runs in-process or as a **durable workflow** (replay-safe, resumable, HITL
via signals).

This is the NestJS module — it re-exports the entire `@dudousxd/nestjs-agent-core` surface, so you
import tools, types, and the module from one place.

## Install

```bash
pnpm add @dudousxd/nestjs-agent @dudousxd/nestjs-agent-core
```

## Use

```ts
import { AgentModule, AiTool, HeaderActorResolver, type ToolHandler } from '@dudousxd/nestjs-agent';
import { z } from 'zod';

@AiTool({ name: 'getWeather', kind: 'read', description: 'Current weather.', input: z.object({ city: z.string() }) })
export class GetWeatherTool implements ToolHandler<{ city: string }> {
  async execute(input: { city: string }) { return { tempC: 21 }; }
}

@Module({
  imports: [AgentModule.forRoot({
    model, store, actorResolver: new HeaderActorResolver(),
    defaultAgent: { systemPrompt: '…', modelId: 'claude-sonnet-4-6' },
  })],
  providers: [GetWeatherTool],
})
export class AppModule {}
```

The module mounts SSE + REST endpoints under `/agent` (`POST /agent/chat`, tool-call approve/reject,
threads, quota). Add `durable: true` + `AgentDurableModule` for the durable runner;
`AgentModule.forFeature([…])` for multi-agent orchestration.

### Deploying split API/worker pods

By default `AgentModule`/`AgentDurableModule` wire everything: every controller, the `agent.run`
durable workflow, and its dispatched steps (`AgentRunSteps.llm`/`.tool`). Fine for a single combined
pod — but an API/dashboard pod and a worker pod each importing the FULL module means the API pod also
registers the dispatched-step handlers, subscribing their queues and running LLM/tool work it has no
business doing (and a worker pod mounts HTTP routes nothing ever calls).

`surface: 'http' | 'engine' | 'both'` (default `'both'`) splits that in two:

```ts
// worker container: no HTTP routes, but the workflow + dispatched steps ARE registered
imports: [
  DurableModule.forRoot({ store, transport }),
  AgentModule.forRoot({ model, store, actorResolver, durable: true, surface: 'engine' }),
  AgentDurableModule.forRoot({ surface: 'engine' }),
]

// api container: every controller works, but AgentRunSteps is never registered here —
// pair this with the durable `drive: false` enqueue-only config so this pod also never
// polls/executes work on its own.
imports: [
  DurableModule.forRoot({ store, transport, drive: false }),
  AgentModule.forRoot({ model, store, actorResolver, durable: true, surface: 'http' }),
  AgentDurableModule.forRoot({ surface: 'http' }),
]
```

`AgentDurableModule.forRoot({ surface })` mirrors `AgentModule`'s own `surface` — set it in both
places (or use the `agentDurable(options)` helper, which threads one `surface` to both calls). The
`'http'` side still registers the `agent.run` WORKFLOW (so starting a run succeeds) but never the
step handlers, so it can never pick up LLM/tool work meant for the worker fleet. This is exactly the
fix for a durable skew-protection crash-loop where a bare-imported module on the wrong pod type
subscribed queues it should never have served. flip composes this the same way `APP_TYPE` composes
its other modules: the worker container loads the `engine` surface, the API container loads `http`.

See the [monorepo README](https://github.com/DavideCarvalho/aviary) for the full guide (durability,
multi-agent, authz, governed SQL, the React frontend, diagnostics).

## License

MIT © Davide Carvalho
