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
  (Vercel AI Gateway `gateway.cost`; OpenRouter `openrouter.usage.cost` from the official
  `@openrouter/ai-sdk-provider` — the per-call cost of the provider the request was routed to). For
  an OpenRouter model the adapter adds `providerOptions.openrouter.usage = { include: true }` (usage
  accounting, which is what makes OpenRouter report cost; your own `openrouter.usage` wins) and warns
  once per model if a call still returns no cost. OpenRouter reached through `@ai-sdk/openai` with a
  custom `baseURL` reports no cost. A direct provider leaves it unset so governance estimates from
  tokens × the pricing table.
- **Boot pricing** — `aiSdkModel` / `aiSdkModels` implement `describeModels()`, so on bootstrap
  `AgentModule` writes the [models.dev](https://models.dev) list price for any configured model the
  bound `AGENT_PRICING_STORE` has no row for (never overwriting one), and warns once about a model
  that would record no cost. `priceCatalog: false` turns the fetch off; it is skipped under
  `NODE_ENV=test` unless set.
- **Model id** — the response's `modelId` is recorded with the turn for cost accounting.

## Several models: `aiSdkModels`

`aiSdkModel(model)` serves one model — a turn that picked another is refused, never silently run on
this one. For a model picker, `aiSdkModels` takes a map (the keys are what a client picks) and
carries the catalog `AgentModule` lists when `models` is omitted:

```ts
import { aiSdkModels } from '@dudousxd/nestjs-agent-ai-sdk';

AgentModule.forRoot({
  model: aiSdkModels(
    {
      fast: { model: openai('gpt-5-mini'), label: 'Fast', badges: ['fast'] },
      smart: { model: anthropic('claude-sonnet-4-5'), label: 'Smart', badges: ['reasoning'] },
      'openai/o3': 'openai/o3', // an AI Gateway id works as the model too
    },
    { default: 'fast', temperature: 0.3 },
  ),
});
```

Entries group by provider (`provider`, else the id's prefix before `/`, else the model's own
provider); `providerLabels` names the groups. A turn with no pick runs on `default` (the first entry
when omitted). For per-actor availability pass your own `models` catalog next to it.

## License

MIT © Davide Carvalho
