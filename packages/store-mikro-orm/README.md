# `@dudousxd/nestjs-agent-store-mikro-orm`

> 🪺 Part of the [Aviary](https://davidecarvalho.github.io/aviary) · a persistence adapter for [`@dudousxd/nestjs-agent`](https://www.npmjs.com/package/@dudousxd/nestjs-agent).

MikroORM persistence for the agent — threads, messages, tool calls, token usage, and model pricing.
Implements the `AgentStore` SPI and binds it to the `AGENT_STORE` token.

## Install

```bash
pnpm add @dudousxd/nestjs-agent-store-mikro-orm @mikro-orm/core @mikro-orm/nestjs
```

## Use

```ts
import { MikroOrmAgentStoreModule } from '@dudousxd/nestjs-agent-store-mikro-orm';

@Module({
  imports: [
    MikroOrmModule.forRoot(/* your config */),
    MikroOrmAgentStoreModule.forFeature(), // registers the agent entities + binds AGENT_STORE
    AgentModule.forRoot({ /* store comes from AGENT_STORE */ model, modelId, store }),
  ],
})
export class AppModule {}
```

The package ships the entities (`EntitySchema`) and `MikroOrmAgentStore`. Run your normal MikroORM
migrations to create the tables, or use the exported schema helper for a quick start.

## The read a turn makes

The agent loop does not call `getThread` to build a prompt. This store implements the core SPI's
`ThreadTurnReader`, so the loop asks it for `loadThreadForTurn({ threadId, messageLimit })` instead:
the thread's newest `messageLimit` messages oldest-first, bounded by the database rather than in
memory, projected to the columns a model turn reads (`usage`, `follow_ups` and `run_id` stay in the
table), plus the title, the default agent, and whether the thread has EVER been answered.

`messageLimit` is the configured `HistoryPolicy.maxMessages`. A policy that summarizes, or whose
ceiling is only a token budget, names no row bound and the whole thread is read — see the core
README. Nothing to wire: the loop probes for the method, and `getThread` remains the right read for
a client rendering a transcript.

## Memory

`MikroOrmMemoryProvider` is a `MemoryProvider` over `agent_memory` — a table this package owns and
heals at boot, alongside every other `agent_*` table, so it is in `agentManagedTables()` and your
migration differ must skip it like the rest.

```ts
import {
  MikroOrmAgentStoreModule,
  MikroOrmMemoryProvider,
} from '@dudousxd/nestjs-agent-store-mikro-orm';

AgentModule.forRootAsync({
  // AGENT_STORE already comes from MikroOrmAgentStoreModule.forFeature(), which is global.
  externalStore: true,
  inject: [MikroOrmMemoryProvider],
  useFactory: (memory: MikroOrmMemoryProvider) => ({
    model,
    actorResolver,
    memory: { provider: memory },
  }),
});
```

The store module exports the provider but never binds `AGENT_MEMORY`: that token's **presence** is
what turns memory on, so binding it here would switch the feature on for every host that installs the
store. Naming the provider is how you opt in.

What it holds to:

- `list` filters `scope in (…)` in the **query**. The library drops out-of-scope records it is handed,
  but that is a backstop — a memory held for another actor or another tenant is never selected, so it
  is unreachable rather than outranked.
- `write` upserts on the (`scope`, `key`) unique index in one statement, so two turns concluding the
  same key at once cannot race to a duplicate-key insert. `pinned`, `created_at` and `id` are excluded
  from the conflict merge: a rewrite must not unpin a record, lose when the belief was formed, or
  invalidate the delete handle a person was already shown.
- `write` refuses an **agent-authored** record at any scope but the actor's own. A human-authored one
  above it is allowed, because that is what a console publishing an organisation's policy does, and
  whether that person may write there is what `memoryWriteVerdict` answers.
- `forget` deletes only from the actor's own scope, so an id alone cannot reach a tenant's memory.
- `pin({ id, pinned })` is the operator act the SPI has no method for — a pin grants a fact a
  permanent place in every future prompt, so nothing an agent can reach may set it. Authorize it in
  your own console.

**`search` is not implemented**, deliberately. It buys a block filled by relevance once the applicable
set outgrows `maxMemories`, and that needs an index over the memories themselves — whose shape depends
entirely on what you already run. Without it, `list` reads the applicable scopes whole and the ceiling
never bites. The signal that it is worth building is `MemoryDigest.omitted` going non-zero, and
`pinnedOmitted` especially: a standing policy that stopped reaching any prompt. Both are on the
`aviary:agent:memory.resolved` diagnostic.

## Attachment housekeeping

`referencedMediaIds(actorRef, mediaIds)` answers which of a set of media ids a message that still
exists carries, for one actor — the inverse of the host's own staged-media inventory, and the half a
sweep cannot work out for itself. It needs **no schema change**: it reads the `attachments` JSON
column messages have carried since attachments shipped, so an existing database answers correctly
the moment you upgrade, with nothing to backfill and no `ensureAgentSchema` heal to wait on — so the
dialect-dependent add-column heal (which does not reach SQLite) is not in the path.

The match happens in memory rather than in SQL. The column holds an array of objects, every dialect
spells that query differently, and none of them can use an index for it; the scan is bounded to one
actor's attachment-bearing messages, and a message with no attachments never leaves the database.

A thread that was soft-deleted still counts as holding its references: the message rows survive, so
the bytes are still reachable from stored state. Delete the thread for real and the cascade makes
them collectable on the next sweep.

## License

MIT © Davide Carvalho
