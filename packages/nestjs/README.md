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

The whole server — a public chat with one tool:

```ts
import { AgentModule, AiTool } from '@dudousxd/nestjs-agent';
import { aiSdkModel } from '@dudousxd/nestjs-agent-ai-sdk';
import { openai } from '@ai-sdk/openai';
import { z } from 'zod';

@AiTool({ description: 'Current weather for a city', input: z.object({ city: z.string() }) })
export class GetWeatherTool {            // name: getWeather, kind: read
  async execute({ city }: { city: string }) { return { city, tempC: 21 }; }
}

@Module({
  imports: [AgentModule.forRoot({ model: aiSdkModel(openai('gpt-5-mini')) })],
  providers: [GetWeatherTool],
})
export class AppModule {}
```

The module mounts SSE + REST endpoints under `/agent` (`POST /agent/chat`, threads, tool-call
approve/reject, quota, models, tools). Everything but `model` defaults, and each default is one
option away:

| Default | Change it with |
|---|---|
| In-memory store (boot warning: not for production) | `store`, or import a store module (`MikroOrmAgentStoreModule.forFeature()`) — found automatically |
| Public endpoints; each browser its own anonymous actor (HttpOnly cookie) | `actorResolver: requestUserActorResolver()` (reads `req.user`), or your own |
| Every tool callable by any resolved actor | `@AiTool({ roles })`, `defaultRoles`, or a `rolesPolicy` |
| `'You are a helpful assistant.'` | `systemPrompt: 'You are …'` or `({ actor }) => …`; `@Agent` classes for personas |
| `@AiTool` name = class name minus `Tool`, camelCased; kind `read` | `@AiTool({ name, kind: 'action' })` |

**Anonymous mode, and what it means.** With no `actorResolver`, anyone who can reach the API can
chat, and each browser gets its own identity: a random token in an `HttpOnly`, `SameSite=Lax`
cookie (`Secure` over HTTPS), the actor id a SHA-256 digest of it. Threads, quota and attachments
are scoped by that id, so visitors never see each other's conversations; clearing cookies starts
over. `action` tools still park on approval — but the approver is the requester, so for an anonymous
visitor approval is a confirmation step, not an authorization: gate a consequential tool with
`roles` (which anonymous actors do not hold). Without a quota, a public deployment's model spend is
unbounded — set `quota` limits (they apply per anonymous id) before going public. Requiring login
is one line: `actorResolver: requestUserActorResolver()`.

### How a chat talks about a tool

A tool's name is an identifier, not copy. Declare how a person-facing surface narrates it beside its
input schema, so whoever renames an input field is the one who re-words the sentence that mentions
it:

```ts
@AiTool({
  name: 'purgeCache',
  kind: 'action',
  description: 'Purge a cache key.',
  input: z.object({ key: z.string() }),
  presentation: {
    label: 'Cache purge',
    running: 'Purging {key}',          // templates over the call's INPUT
    done: 'Purged {key}',
    icon: 'cache',                     // a key into the client's own glyph map
    tone: 'destructive',
    confirm: { title: 'Purge {key}?', verb: 'Purge' },
    result: { kind: 'metrics', fields: [{ path: 'evicted', label: 'Evicted' }] }, // over the OUTPUT
  },
})
```

`GET /agent/tools?agent=<name>` returns `ToolCatalogEntry[]` — `{ name, kind, presentation? }` for the
tools THIS actor can reach through that agent (the default agent when omitted; `404` for an unknown
one), built by `ToolRegistry.visibleSpecs`, the same gates the model is offered tools through. The
React package's `useToolCatalog` reads it. The model never sees `presentation`.

### Generative UI

A tool pushes a component into the answer with `ctx.emitUi(component, props)` — always present; a
no-op where there is no conversation (MCP). To let the MODEL compose UI from a catalog, import
`AgentGenuiModule` from `@dudousxd/nestjs-agent/genui` next to `AgentModule`:

```ts
// catalog.ts — isomorphic: the React app imports this same file
import { defineCatalog, defineComponent } from '@dudousxd/nestjs-agent-core/genui';
import { BUILTIN_COMPONENTS } from '@dudousxd/nestjs-agent-core/genui/builtins';
export const catalog = defineCatalog([...BUILTIN_COMPONENTS, DealCard]);

// app.module.ts
AgentGenuiModule.forRoot({ catalog, mode: 'tree', terminal: true });
```

It registers the tools (`ui__show_<component>` per component by default, one `ui__render` in `tree`
mode, plus a generic `ui__show` taking `{ component, props }` with `showTool: true`), validating
every call against the catalog. Options: `mode`, `terminal`, `treeToolName`, `treeInstructions`,
`treeLimits`, `namePrefix`, `showTool`, `showInstructions`, `roles`, `presentation`.
`forRootAsync({ imports, inject, useFactory })` builds them from config. The catalog is injectable
(`@InjectGenuiCatalog()`, token `GENUI_CATALOG`) and replaceable in a test with
`overrideProvider(GENUI_CATALOG)` — the tools are built from the injected one.

**Per-request catalogs.** Pass `resolver` (a class, resolved with DI, or an instance) extending
`GenuiCatalogResolver` — `resolve({ actor, threadId, tenant, agentName }) → Catalog | Promise<Catalog>`
(`tenant` is `actor.tenantRef`). It is consulted when a call is validated and when a turn's tool list
is described to the model (the core's `ToolHandler.describe`), so tenant-defined, versioned
components work without rebuilding tools at boot: the tree tool's and the show tool's descriptions
and schemas list the tenant's components for that turn, and a pushed component carries the resolved
definition's `version`. A tenant's own components are reached through the tree tool or
`showTool: true` — no boot-time tool can name them. Cache inside `resolve` if it costs a round trip.

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

`POST /agent/attachments` (multipart, live whenever a staging store is bound — `501` otherwise)
aborts a body larger than `HARD_MAX_ATTACHMENT_BYTES` (32 MiB) while it streams; the configured
`maxBytes` narrows that ceiling at request time and cannot raise it. The limits come from ONE place:
the staging store's own `describe()` when it declares them (`AgentMediaAttachmentsModule` does),
else `AgentModule`'s `attachments: { maxBytes, allowedContentTypes }`, else 20 MiB and the default
types. `GET /agent/config` serves them — with the upload mode (`multipart` or `resumable`) and the
per-message cap — so a client never repeats them.

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
minted per turn by `resolve`), bounded to `ATTACHMENT_PAGE_SIZE`. It takes no `threadId` filter: a thread's attachments already
ride on its messages in `GET /agent/threads/:id`.

### Attachments on nestjs-media (`@dudousxd/nestjs-agent/media`)

A ready `AGENT_ATTACHMENT_STAGING` backed by [`@dudousxd/nestjs-media`](https://davidecarvalho.github.io/aviary/docs/media),
with resumable (tus) uploads. `@dudousxd/nestjs-media` is an **optional** peer: only this subpath
imports it, and nothing on the root entry needs it.

Minimal — next to a `MediaModule` that has `store`, `uploadSessions` and `tus`:

```ts
@Module({
  imports: [
    MediaModule.forRoot({ /* disks, store, uploadSessions, tus */ }),
    AgentModule.forRoot({ /* … */ }),
    AgentMediaAttachmentsModule.forRoot(), // ← the whole integration
  ],
})
// main.ts — nestjs-media's own requirement for tus PATCH bodies:
app.useBodyParser('raw', { type: 'application/offset+octet-stream' });
```

Everything is overridable when you need it:

```ts
AgentMediaAttachmentsModule.forRoot({
  maxBytes: 50 * 1024 * 1024,
  allowedContentTypes: ['image/png', 'image/jpeg', 'application/pdf'],
  collection: 'chat-files',
  canAccess: ({ allowed, actor }) => allowed || actor.roles?.includes('support') === true,
  resolveUrl: (record) => signMyProxyUrl(record.id), // instead of presign / public / inline
  indexForRag: true, // see below
  guards: [SessionGuard],
});
```

Each attachment is a media record (`ownerType: 'agent-actor'`, `ownerId: actor.id`, collection
`agent-attachments`). The upload never goes through the agent:

| Step | Route | Who serves it |
| --- | --- | --- |
| 1. open | `POST /agent/attachments/uploads` `{ filename, contentType, size }` → `{ mediaId, uploadId, location }` | agent — validates type/size and opens a tus session the actor owns |
| 2. bytes | `PATCH <location>` (tus, chunked, resumable) | **nestjs-media** |
| 3. complete | `POST /agent/attachments/uploads/:mediaId/complete` → `MessageAttachment` | agent — checks the bytes landed at the declared size |
| drop | `DELETE /agent/attachments/uploads/:mediaId` | agent — aborts the session, deletes bytes + record |

`@dudousxd/nestjs-agent-react/media` drives all three for `useAttachments`; this is THE upload route
with this module (`GET /agent/config` answers `upload: 'resumable'`). The buffered multipart `POST
/agent/attachments` still stages into the same store, but is not the documented path here; `GET
/agent/attachments` lists either kind. The module's `maxBytes` / `allowedContentTypes` are the only
limits in force — `AgentModule`'s `attachments` option is ignored while it is imported.

A replayed thread (`GET /agent/threads/:id`) re-mints each attachment's url from the store by
`mediaId` on every read, so an old turn never shows an expired presigned link.

`resolve` hands the model provider a presigned url when the disk can mint one (`urlExpiresInSeconds`,
default 7 days), the disk's public `url()` with `visibility: 'public'`, or — on a disk that can do
neither, such as local disk in development — the bytes inline as a `data:` url (logged once; that
url is persisted with the message). `resolveUrl(record, { disk })` takes over entirely. The actor may
use media they own, and media a message in one of their own threads already carries; anything else
resolves `null` (`403` on the chat route).

Cleanup: an upload abandoned half-way is already a record, so it shows up in `list` and ages into
`collectableAttachments`. Delete through the store so the tus session is aborted too:

```ts
const media = app.get(MediaAttachmentStaging);
for (const entry of await agents.collectableAttachments(actor, { olderThan })) {
  await media.remove(entry.mediaId);
}
```

`indexForRag: true` announces every ready attachment on `aviary:media:attach` (and its removal on
`aviary:media:delete`) so `@dudousxd/nestjs-agent-rag-media` indexes it. Off by default — only turn
it on where retrieval is filtered by owner (`FilteredRetriever` on `ownerType`/`ownerId`), and
restrict rag-media's `collections` accordingly.

`forRootAsync({ imports, inject, useFactory, path, guards })` takes the same options; `path` must
match `AgentModule`'s `path` (default `agent`), and `guards` gates the upload routes.

### Bring your own storage

Nothing requires nestjs-media. Bind your own `AttachmentStagingStore` and upload however you like:

```ts
@Injectable()
export class S3Staging implements AttachmentStagingStore {
  async stage({ data, filename, contentType, actor }: StageAttachmentInput) {
    const mediaId = randomUUID();
    await this.s3.put(`chat/${actor.id}/${mediaId}`, data, { contentType });
    await this.db.insert(files).values({ mediaId, owner: actor.id, filename, contentType });
    return { mediaId, url: '', contentType, name: filename };
  }
  async resolve({ mediaId, actor }: ResolveAttachmentInput) {
    const row = await this.db.query.files.findFirst({ where: eq(files.mediaId, mediaId) });
    if (!row || row.owner !== actor.id) return null; // unknown and foreign look the same
    const url = await this.s3.presign(`chat/${actor.id}/${mediaId}`, 3600);
    return { mediaId, url, contentType: row.contentType, name: row.filename };
  }
}

// alongside AgentModule, in a @Global() module (or any module AgentModule can see):
{ provide: AGENT_ATTACHMENT_STAGING, useClass: S3Staging }
```

Then the built-in `POST /agent/attachments` calls your `stage` (no flag — binding the store is what
turns it on), or upload through your own route and give the React side your own `upload`
(`useAttachments({ upload })` / a backend's `uploadAttachment`) that resolves to a `{ mediaId, … }`
your `resolve` recognises. `list` is optional and only needed for `GET /agent/attachments` and
sweeping.

### A turn that dies mid-step

A failing run settles what it left: the calls it had put to a person become `failed`
(`AgentStore.failUnsettledToolCalls`), its run row is settled and its thread released — also when
the durable runtime refused a checkpoint position, where nothing can be journaled and the three
are written straight to the store. The next turn on the thread is shown a result for every tool
call the dead one made. `AgentService.approve` / `reject` / `answer` / `skip` (and
`signalToolCall`) throw `RunNotActiveException` — `409 { code: 'run_not_active' }` — when the run
that asked has ended, instead of signalling a run that will never read it. The stream's error
frame carries a stable `code` and, in production, a generic message (`exposeStreamErrorDetails`
from core overrides that); the error itself is logged with its run id and kept on the run row.

A tool receives `ctx.idempotencyKey` (`<runId>:<toolCallId>`) — pass it on to whatever the tool
writes to, so a call re-executed after a worker crash lands on the first attempt.

### Who may read a run

`GET /agent/chat/:runId/stream` and `POST /agent/chat/:runId/cancel` both resolve the acting actor
and require they own the run currently streaming — `403` for another actor's run, `404` for a run
nobody is streaming (including one that has already finished). In-process callers that are
authorized elsewhere use `AgentService.subscribe(runId)`; anything reachable from a request must go
through `AgentService.subscribeAs(actor, runId)`.

### Resuming a dropped stream

Every event frame of `POST /agent/chat` and `GET /agent/chat/:runId/stream` carries an SSE `id:` —
its 1-based position in the run, the same on every attach (a runner of your own may number with gaps,
as long as ids only increase — see *Numbering a stream you rebuild* in the protocol doc). `GET …/stream?after=<n>` (or the
`Last-Event-ID` header) skips what a reconnecting client already has; the React transport uses it to
continue a message after a network drop. See docs/stream-protocol.md.

### Sending while a turn is running (the message queue)

`POST /agent/chat` on a thread that already has a turn running no longer starts a second one: the
message is queued on the thread (persisted — it survives restarts) and the answer is `202 { queued:
true, messageId, position, queue }`. When the running turn completes, the next queued message
starts under its own id, and the settling turn's stream says so in a final `queue` frame
(`started: { messageId, runId }`). `mode: 'interrupt'` cancels the running turn and runs the message
next; `mode: 'queue'` always queues. A failed turn or a Stop pauses the queue (`POST
/agent/threads/:id/queue/resume` lifts it); an exhausted quota pauses it as the next message starts.
`POST /agent/queue/:messageId/interrupt` runs a message that is already waiting now — it moves to
the head as an interrupt and the running turn is cancelled for it, in one request.
`GET`/`DELETE /agent/threads/:id/queue`, `PATCH`/`DELETE /agent/queue/:messageId` list, clear,
edit, move and remove what is waiting.

Both runners and both SQL stores support it (`ChatQueueStore`; the stores add an
`agent_queued_message` table and an `agent_thread.queue_pause` column on boot). Admission is a
compare-and-set on the thread's active run, so exactly one turn runs per thread across pods, and a
durable drain is journaled — it never starts a queued message twice. `AgentService.chat()` stays a
start-or-refuse call for in-process callers (`409 run_active` on a busy thread); `send()` is the
queueing one. Policy and wire contract: *Message queue* in docs/stream-protocol.md.

### Message feedback

`POST /agent/messages/:id/feedback` `{ value: 'up' | 'down' | null, comment? }` rates a message in
one of the caller's threads (`null` clears it) and answers `{ feedback }`; `GET /agent/threads/:id`
returns it on the message. It needs a store with `threadOfMessage` + `setMessageFeedback` (both
bundled stores and `InMemoryAgentStore` have them) — `501` otherwise.

### Letting callers pick a model

```ts
AgentModule.forRoot({
  model: aiSdkModels(
    {
      'openai/gpt-4o-mini': { model: 'openai/gpt-4o-mini', label: 'GPT-4o mini', badges: ['fast'] },
      'openai/o3': { model: 'openai/o3', label: 'o3', badges: ['reasoning'] },
    },
    { default: 'openai/gpt-4o-mini' },
  ),
});
```

`aiSdkModels` (from `@dudousxd/nestjs-agent-ai-sdk`) carries its own catalog, used when `models` is
omitted. For availability that depends on the caller, pass a `models` catalog of your own next to it:

```ts
models: {
  list: ({ actor }) => ({
    default: 'openai/gpt-4o-mini',
    providers: [{ id: 'openai', label: 'OpenAI', models: [
      { id: 'openai/gpt-4o-mini', label: 'GPT-4o mini', available: true },
      { id: 'openai/o3', label: 'o3', available: actor.roles?.includes('PRO') === true, unavailableReason: 'Pro plan' },
    ] }],
  }),
},
```

`GET /agent/models?agent=` answers the catalog for the caller (empty without one). A turn runs on
the send's `model`, else the thread's pinned one (`PATCH /agent/threads/:id { model }`), else the
provider's default; the id reaches the provider as `ModelTurnArgs.model` for every call of the turn.
A model the catalog does not list as available for that actor and agent is refused with `400` —
when pinned and again on each turn — and a provider asked for a model it does not serve fails the
turn rather than answering on another. `staticModelCatalog(view)` wraps a fixed list.

### Budgets: `GET /agent/quota`

`GET /agent/quota` reports `{ windows: [{ period: 'day' | 'month', usedTokens?, limitTokens?,
usedUsd, limitUsd?, resetsAt?, warnAt? }], blocked?, warning? }` from a `QuotaProvider` (a USD-only
budget leaves `usedTokens` out; `quota: { limits, warnAt: 0.8 }` adds a soft-limit `warning`). The default,
`LedgerQuotaProvider`, reads the usage ledger (day, plus month when the store has `usageBetween`)
and only reports. Configure it and it also gates sends — a `blocked` report refuses `POST
/agent/chat` with `429 { code: 'quota_exceeded', period }` before the turn starts:

```ts
AgentModule.forRoot({
  // ceilings on the default ledger provider
  quota: { limits: { day: { tokens: 200_000 }, month: { usd: 20 } } },
  // …or your own budget, e.g. an AI-gateway spend cap:
  // quota: { report: async ({ actor }) => myGatewayBudget(actor.id) },
});
```

In anonymous mode the limits apply per browser (each is its own actor).

### Who approves an action, and for how long

Every `action` tool call waits on the person chatting by default. `approvalPolicy` changes that per
call:

```ts
AgentModule.forRoot({
  // …
  approvalPolicy: {
    requirementFor: (tool, actor) =>
      tool.name === 'issueRefund'
        ? { required: true, approver: 'finance', ttlMs: 15 * 60_000 }
        : { required: true, approver: 'requester' },
    // Optional. Default: 'requester' = the thread's own actor, anything else = a role the decider holds.
    // canDecide: (actor, { approver, requesterRef }) => gate.forUser(actor).allows('approve', approver),
  },
});
```

- `POST /agent/tool-call/approve` `{ toolCallId, remember?, via? }` and `…/reject` `{ toolCallId,
  reason?, via? }` enforce the recorded approver (`403` otherwise) and refuse a request that has
  lapsed (`410`). The decider is recorded as `executedByRef`, `via` as `decided_via` (`'web'` when
  omitted; the console approvals port takes `decidedVia` too).
- `remember: true` approves later calls of the same tool in the same thread without asking.
- A `ttlMs` becomes the approval wait's timeout — `ctx.waitForSignal(…, { timeoutMs })` on the
  durable runner, a timer inline. On expiry the call settles `expired`, the model is told nobody
  approved it in time, and the stream carries `tool-output-denied` + `approval-settled`.
- The tool-call row gains `approver`, `expires_at`, `remember` and `decided_via`; a reloaded thread
  carries them as `StoredMessage.approvals`.

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

### Guardrails

`@dudousxd/nestjs-agent/guardrails` (a re-export of `@dudousxd/nestjs-agent-core/guardrails`) puts
PII, secret, prompt-injection and tool-poisoning checks on the processor seams:

```ts
import { createGuardrails } from '@dudousxd/nestjs-agent/guardrails';

const guardrails = createGuardrails({ pii: 'redact', secrets: 'block', injection: { threshold: 0.6 } });

AgentModule.forRoot({
  model, store, actorResolver,
  inputProcessors: [guardrails.input],
  outputProcessors: [guardrails.output],
});
```

See the core package's README for the stages, the actions and the standalone API.

See the [monorepo README](https://github.com/DavideCarvalho/aviary) for the full guide (durability,
multi-agent, authz, governed SQL, the React frontend, diagnostics).

## License

MIT © Davide Carvalho
