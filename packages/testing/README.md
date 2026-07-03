# `@dudousxd/nestjs-agent-testing`

> 🪺 Part of the [Aviary](https://davidecarvalho.github.io/aviary) · test doubles for [`@dudousxd/nestjs-agent`](https://www.npmjs.com/package/@dudousxd/nestjs-agent).

In-memory adapters and a deterministic fake model, so you can exercise the whole agent loop —
read-tool auto-execution, action-tool HITL, multi-agent delegation — offline, with no API key, DB,
or Redis.

## Install

```bash
pnpm add -D @dudousxd/nestjs-agent-testing
```

## Use

```ts
import {
  InMemoryAgentStore,
  InMemoryQuotaStore,
  InMemoryTokenStreamSink,
  FakeModelProvider,
  type FakeScript,
} from '@dudousxd/nestjs-agent-testing';

// A FakeScript branches on the conversation + turn index to drive the loop deterministically:
const script: FakeScript = (args, turnIndex) =>
  turnIndex === 0
    ? { text: 'checking', toolCall: { name: 'getWeather', input: { city: 'Recife' } } }
    : { text: 'it is 21C' };

AgentModule.forRoot({
  model: new FakeModelProvider(script),
  store: new InMemoryAgentStore(),
  quota: new InMemoryQuotaStore(200_000),
  actorResolver: new HeaderActorResolver(),
  defaultAgent: { modelId: 'fake-1' },
});
```

`InMemoryAgentStore` also exposes inspection helpers (`toolCallRows()`, `usageRows()`) for assertions.

## License

MIT © Davide Carvalho
