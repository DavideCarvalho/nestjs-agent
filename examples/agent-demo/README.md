# agent-demo

A runnable, **offline** proof of `@dudousxd/nestjs-agent`: a governed AI agent whose turn
runs as a **durable workflow**, streams over SSE, pauses for **human approval** on a
destructive tool, and lights up the **diagnostics** channel — all with no API key and no
external infra (the model is a deterministic fake; the durable engine and state store run
in-process).

## Run it

```bash
# from the monorepo root
pnpm install
pnpm build                 # build the workspace packages the demo links to

# then
pnpm --filter agent-demo demo
```

`pnpm demo` boots the Nest app in-process, runs two scenarios, and exits.
To run the server on its own and poke it with curl, use `pnpm --filter agent-demo start`.

## What it shows

**Scenario 1 — read tool (auto-executed).** "What is the weather in Recife?" → the agent
streams a reply, calls the `getWeather` read tool automatically, then answers. You'll see the
`aviary:agent:*` diagnostics events print (`run.started`, `message`, `tool-call`, `run.finished`).

**Scenario 2 — action tool (HITL).** "Please purge the app cache" → the agent wants to call
`purgeCache`, a **destructive action tool**. The durable run **suspends on `ctx.waitForSignal`**
(it is not holding a connection or a process — the workflow is parked in the state store). The
demo then approves via `POST /agent/tool-call/approve`, which delivers a durable **signal**; the
run **resumes by replay** — note the `run.started`/`message` events appear again, because the
durable engine re-runs the workflow and the already-completed model/tool steps return from
**checkpoint cache** rather than re-executing. The post-approval answer then streams.

It finishes by printing today's token quota and the thread count.

## How it's wired (`src/app.module.ts`)

```ts
DurableModule.forRoot({ store: new InMemoryStateStore() }),   // durable engine, in-process
AgentModule.forRoot({
  model: demoModel,                  // deterministic offline fake (swap for a Vercel AI SDK provider)
  store: new InMemoryAgentStore(),   // swap for @dudousxd/nestjs-agent-store-mikro-orm
  quota: new InMemoryQuotaStore(200_000),
  modelId: 'fake-demo-1',
  durable: true,                     // run each turn as the `agent.run` durable workflow
}),
AgentDurableModule,                  // from '@dudousxd/nestjs-agent/durable'
```

Tools are plain providers decorated with `@AiTool` (`src/tools/*.tool.ts`) — discovery
registers them at boot. Swap the fake model for `@ai-sdk/anthropic` / `@ai-sdk/amazon-bedrock`,
the in-memory store for the MikroORM adapter, and the in-process state store for a SQL one, and
the same code is production-ready.

## API surface exercised

- `POST /agent/chat` — start a turn, stream SSE
- `GET /agent/threads/:id` — read the thread (used to find the pending tool call)
- `POST /agent/tool-call/approve` — deliver the HITL approval signal
- `GET /agent/quota/today`, `GET /agent/threads`
