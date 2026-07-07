# `@dudousxd/nestjs-agent-ai-sdk`

> 🪺 Part of the [Aviary](https://davidecarvalho.github.io/aviary) · a model adapter for [`@dudousxd/nestjs-agent`](https://www.npmjs.com/package/@dudousxd/nestjs-agent).

Maps the [Vercel AI SDK](https://ai-sdk.dev) v7 to the core `ModelProvider` SPI so you write **zero
provider code**. One call — `aiSdkModel(model)` — turns any AI SDK `LanguageModel` (a gateway string
like `'openai/gpt-4o'`, or a provider model instance) into the `ModelProvider` the agent module runs.
It is the first of a family of model adapters; core's `ModelProvider` stays the single seam.

## Install

```bash
pnpm add @dudousxd/nestjs-agent-ai-sdk ai
```

## Use

```ts
import { aiSdkModel } from '@dudousxd/nestjs-agent-ai-sdk';
import { AgentModule } from '@dudousxd/nestjs-agent';

@Module({
  imports: [
    AgentModule.forRoot({
      model: aiSdkModel('anthropic/claude-sonnet-4'), // any AI SDK v7 LanguageModel
      modelId: 'anthropic/claude-sonnet-4',
    }),
  ],
})
export class AppModule {}
```

Pass a provider model instance instead of a gateway string when you want to configure the provider
directly, and forward extra `streamText` settings via the second argument:

```ts
import { openai } from '@ai-sdk/openai';

aiSdkModel(openai('gpt-4o'), { temperature: 0.2, headers: { 'x-tenant': 'acme' } });
```

## What it does per turn

`runTurn` calls the SDK's `streamText`, streams text deltas to the live token sink, and assembles
the result the agent loop needs:

- **Streaming** — `fullStream` text deltas are written to `args.sink` as bytes, in order.
- **Tools** — core `ToolDefinition`s are handed to the SDK **without** an `execute` function, so the
  model returns tool-calls for the loop to run as its own (replay-safe) steps rather than executing
  them inline. A tool's `StandardSchemaV1` is passed straight through when it exposes the Standard
  JSON Schema converter (Zod/Valibot/ArkType), otherwise it falls back to a permissive object schema.
- **Usage** — SDK usage maps to `MessageUsage`, including `cacheReadTokens` / `cacheWriteTokens` /
  `reasoningTokens` when the provider reports them.
- **Cost** — a real USD `costUsd` is pulled from `providerMetadata` when a gateway reports it
  (Vercel AI Gateway `gateway.cost`, OpenRouter `total_cost`); a direct provider leaves it unset so
  governance estimates from tokens.
- **Model id** — the response's `modelId` is recorded with the turn for cost accounting.

## License

MIT © Davide Carvalho
