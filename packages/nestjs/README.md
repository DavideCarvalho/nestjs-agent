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
import { AgentModule, AiTool, type ToolHandler } from '@dudousxd/nestjs-agent';
import { z } from 'zod';

@AiTool({ name: 'getWeather', kind: 'read', description: 'Current weather.', input: z.object({ city: z.string() }) })
export class GetWeatherTool implements ToolHandler<{ city: string }> {
  async execute(input: { city: string }) { return { tempC: 21 }; }
}

@Module({
  imports: [AgentModule.forRoot({ model, store, modelId: 'claude-sonnet-4-6', systemPrompt: '…' })],
  providers: [GetWeatherTool],
})
export class AppModule {}
```

The module mounts SSE + REST endpoints under `/agent` (`POST /agent/chat`, tool-call approve/reject,
threads, quota). Add `durable: true` + `AgentDurableModule` for the durable runner;
`AgentModule.forFeature([…])` for multi-agent orchestration.

See the [monorepo README](https://github.com/DavideCarvalho/aviary) for the full guide (durability,
multi-agent, authz, governed SQL, the React frontend, diagnostics).

## License

MIT © Davide Carvalho
