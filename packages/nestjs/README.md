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

### Message attachments

A chat turn attaches a file by **`mediaId` only**:

```jsonc
POST /agent/chat
{ "message": "what is in this?", "attachments": [{ "mediaId": "med_8f21…" }] }
```

Every other field a client sends with it is discarded. The url the model provider fetches is read
back from the `AttachmentStagingStore` bound to `AGENT_ATTACHMENT_STAGING`, whose `resolve({ mediaId,
actor })` returns the attachment or `null` when the id is unknown or is not that actor's — so a
caller can never point the server at a url it chose (link-local metadata, an internal service), and
never at another actor's file. Resolution happens per turn, so a short-lived presigned url is minted
fresh rather than replayed from the stored message.

With nothing bound to `AGENT_ATTACHMENT_STAGING` there is no way to tell whose media an id is, so a
turn carrying attachments is refused with `501`. Text-only turns are unaffected. At most 10
attachments per turn.

The optional `POST /agent/attachments` upload route (`attachments: { upload: true }`) aborts a body
larger than `HARD_MAX_ATTACHMENT_BYTES` (32 MiB) while it streams; `attachments.maxBytes` narrows
that ceiling at request time and cannot raise it.

### Sweeping attachments nobody sent

`stage()` writes bytes before any message exists, so a user who attaches a file and then never sends
it leaves media with nothing pointing at it. Two optional methods make that findable — `list` on
your `AttachmentStagingStore` (you stored the bytes, so only you can enumerate them) and
`referencedMediaIds` on your `AgentStore` (only it can see which media a live message carries).

```ts
// a job the host runs; nothing here is reachable over HTTP
const olderThan = new Date(Date.now() - 48 * 60 * 60 * 1000);
for (const entry of await agents.collectableAttachments(actor, { olderThan })) {
  await myMediaStore.delete(entry.mediaId); // the library never deletes your bytes
}
```

`olderThan` is required and has no default: freshly staged media is an upload in flight, not
garbage, and only you know how long one of your composers may sit open. It is pushed down to `list`
and re-applied to the result, so a store that ignores the hint still cannot delete a live upload.

References are re-derived on every call rather than latched, because `truncateFrom` — which is what
regenerating a turn does — deletes messages and frees their media again. If either method is
missing the call raises `501` rather than reporting everything as collectable.

`GET /agent/attachments` returns the caller's own staged files as metadata (no urls — those are
minted per turn by `resolve`), bounded to `ATTACHMENT_PAGE_SIZE`, and rides the same
`attachments: { upload: true }` flag. It takes no `threadId` filter: a thread's attachments already
ride on its messages in `GET /agent/threads/:id`.

### Who may read a run

`GET /agent/chat/:runId/stream` and `POST /agent/chat/:runId/cancel` both resolve the acting actor
and require they own the run currently streaming — `403` for another actor's run, `404` for a run
nobody is streaming (including one that has already finished). In-process callers that are
authorized elsewhere use `AgentService.subscribe(runId)`; anything reachable from a request must go
through `AgentService.subscribeAs(actor, runId)`.

### A durable turn's model call and tools run in a worker

Under `durable: true` the turn's model call and each of its tool executions are **dispatched steps**
(`AgentRunSteps.llm` / `AgentRunSteps.tool`), which is what `ctx.step` means in
[`@dudousxd/nestjs-durable`](https://davidecarvalho.github.io/aviary/docs/durable): they are routed
to whichever worker serves those groups, not run in the pod that took the request. There is no
option to place them anywhere else.

So a `@AiTool` handler is in the same position as any `@Step` handler: it has no caller's execution
context to inherit. A handler that reaches for a request-scoped ORM EntityManager, an
AsyncLocalStorage tenant or a CLS transaction must establish that itself — under MikroORM, that is
`@CreateRequestContext()` (or `@EnsureRequestContext()`) on the handler:

```ts
@AiTool({ name: 'closeWorkOrder', kind: 'action', description: '…', input: z.object({ id: z.string() }) })
export class CloseWorkOrderTool implements ToolHandler<{ id: string }> {
  constructor(private readonly em: EntityManager) {}

  @CreateRequestContext()
  async execute(input: { id: string }) {
    /* … */
  }
}
```

A handler that skips it fails inside the worker, and an `action` tool is where that costs most: the
call is recorded `failed`, the error is handed to the model, the turn completes — and a human's
approval has been spent on an action that never ran.

Multi-pod fleets also need a cross-process `TokenStreamSink` (e.g.
`@dudousxd/nestjs-agent/sink-redis`), since the worker writing tokens is generally not the pod
holding the reader's SSE connection. The default in-process sink logs a warning at boot under
`durable: true` for exactly this reason.

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
