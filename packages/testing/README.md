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

`InMemoryAttachmentStagingStore` is the host half of the attachment surface — `stage` / `resolve` /
`list`, plus `setClock()` to stage media at a chosen instant and `delete()` to stand in for a host
collecting bytes. It is a complete implementation, per-actor checks included, so a sweep
(`AgentService.collectableAttachments`) can be exercised end to end without an object store.

### Memory

`InMemoryMemoryProvider` is a complete `MemoryProvider`: scope-gated `list`, a `write` that upserts
on (`scope`, `key`) and preserves `pinned`, a `forget` restricted to the actor's own scope, and
`pin()` for the operator act the SPI deliberately has no method for.

```ts
import { InMemoryMemoryProvider } from '@dudousxd/nestjs-agent-testing';

AgentModule.forRoot({
  // ...model, store, actorResolver
  memory: { provider: new InMemoryMemoryProvider() },
});
```

Pass `{ recall: true }` and it also serves `search`, ranking by word overlap — enough to exercise the
relevance path, `MemoryDigest.recalled`, and the clause an adapter is most likely to get wrong (every
record sharing a ranked key travels, plus every pinned one, or precedence silently collapses to the
wider value). Without it there is no `search` property at all, which is the switch the loop reads.

`everyMemoryField(ctx)` / `expectedMemoryRecord(...)` are the round-trip fixtures, typed
`Required<StoreMemoryInput>` and `Required<MemoryRecord>`: a new field on either shape fails to
**compile** until your adapter can name it. Hold your own provider to them the same way
`EVERY_MESSAGE_FIELD` holds a store.

## License

MIT © Davide Carvalho
