# `@dudousxd/nestjs-agent-telescope`

> 🪺 Part of the [Aviary](https://davidecarvalho.github.io/aviary) · an "Agent" tab for [`@dudousxd/nestjs-telescope`](https://www.npmjs.com/package/@dudousxd/nestjs-telescope).

Adds an **Agent** dashboard to Telescope. It subscribes to the `aviary:agent:*` diagnostics channel
and surfaces runs, messages, tool calls, delegations, quota events, and cost — no instrumentation in
your code.

The dashboard is fed by **three sources**:

- **Live activity** — the `aviary:agent:*` diagnostics watcher records into Telescope's ephemeral
  event storage. Powers the **Overview** (runs / tokens) and **Tools** (status breakdown + recent
  tool calls) sections.
- **Authoritative spend & usage** — the shared `AGENT_GOVERNANCE_QUERIES` read-model (usage joined to
  model pricing, restart-surviving). Powers the governance sections:
  - **Spend** — total $ + total tokens for the range, a spend-by-model donut, and a daily
    spend/tokens trend (timeseries).
  - **Models** — per-model requests / input+output tokens / cost table.
  - **Actors** — spend share by actor (breakdown) + spend-by-actor table.
- **Retrieval telemetry** — the `aviary:rag:retrieval` channel `@dudousxd/nestjs-agent-rag` emits,
  recorded as its own `agent-rag` entry type. Powers:
  - **Retrieval** — retrievals, zero-hit rate, passages per retrieval, a latency histogram with
    p50/p95/p99 markers, a top-score histogram (dense retrievals only — see below), and a
    retrievals/zero-hits trend.
  - **Retrieval sources** — retrievals by store and by retriever kind, a per-collection rollup, and
    the slowest retrievals in the window.

  These need no DI binding, but stay empty until something emits retrieval telemetry:
  `createRetrievalTool` does by default, `instrumentRetriever(retriever)` covers every other call
  path. They read Telescope's own storage, so they show what **this process** has seen within
  Telescope's retention — a live view, not a ledger.

  The score histogram is bound to one retriever kind (`query: { retriever: 'embedding' }`) on
  purpose: a cosine similarity, a BM25 score and an RRF rank score share no scale, so pouring them
  into one histogram gives bins that mean a different thing per bar.

## Wiring the governance sections

The governance providers resolve `AGENT_GOVERNANCE_QUERIES` from the host DI container at request time
(via `ctx.moduleRef`). Bind that token — from your store adapter (`@dudousxd/nestjs-agent-store-mikro-orm`,
`-store-drizzle`, or the in-memory `-testing` adapter) — in the **same module** that registers Telescope:

```ts
import { AGENT_GOVERNANCE_QUERIES } from '@dudousxd/nestjs-agent-core';
import { agentTelescopeExtension } from '@dudousxd/nestjs-agent-telescope';

@Module({
  imports: [TelescopeModule.forRoot({ extensions: [agentTelescopeExtension()] })],
  providers: [
    { provide: AGENT_GOVERNANCE_QUERIES, useExisting: MyStoreGovernanceQueries },
  ],
})
export class ObservabilityModule {}
```

If the token is not bound, the governance panels render an empty state; the live watcher-fed panels
keep working regardless.

## Adding your own panels to this dashboard

An application's own RAG data — its knowledge-base collections, its ingestion log — lives in the
app, not in this library. Contribute it through **this** extension:

```ts
agentTelescopeExtension({
  providers: [
    { name: 'myapp.rag.collections', resolve: async () => ({ rows: await listCollections() }) },
    { name: 'myapp.rag.documents', resolve: async () => ({ value: await countDocuments() }) },
  ],
  sections: [
    {
      title: 'Knowledge base',
      cols: 2,
      panels: [
        { kind: 'stat', title: 'Documents', data: { provider: 'myapp.rag.documents' } },
        {
          kind: 'table',
          title: 'Collections',
          data: { provider: 'myapp.rag.collections' },
          columns: [
            { key: 'name', label: 'Collection' },
            { key: 'documents', label: 'Documents' },
          ],
        },
      ],
    },
  ],
});
```

Two rules, both load-bearing:

- **Register the providers here, not in a second extension.** The UI derives the request path from
  the dashboard id (`agent.overview` → `GET /ext/agent/data/:provider`) and the server 404s when the
  provider's owning extension does not match that segment. A provider contributed by another
  extension is unreachable from a panel on this page — the panel renders an error, not data.
- **Name them under your own prefix.** Anything starting with `agent.` is refused at boot; a
  collision there surfaces as Telescope's generic "contributed by both agent and agent" error, which
  names the same extension twice.

Sections are appended after the built-in ones. Size each one's panel count to an exact multiple of
its `cols` — the renderer lays a section out as a fixed `grid-cols-N` grid with no `colSpan`, so an
orphan panel leaves a visible hole beside it.

Providers resolve `ctx.moduleRef` at request time, so they can reach any host service the module
container exposes.

## Install

```bash
pnpm add @dudousxd/nestjs-agent-telescope
```

## Use

```ts
import { agentTelescopeExtension } from '@dudousxd/nestjs-agent-telescope';

TelescopeModule.forRoot({
  extensions: [agentTelescopeExtension()],
});
```

## License

MIT © Davide Carvalho
