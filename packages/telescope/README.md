# `@dudousxd/nestjs-agent-telescope`

> 🪺 Part of the [Aviary](https://davidecarvalho.github.io/aviary) · an "Agent" tab for [`@dudousxd/nestjs-telescope`](https://www.npmjs.com/package/@dudousxd/nestjs-telescope).

Adds an **Agent** dashboard to Telescope. It subscribes to the `aviary:agent:*` diagnostics channel
and surfaces runs, messages, tool calls, delegations, quota events, and cost — no instrumentation in
your code.

The dashboard is fed by **two sources**:

- **Live activity** — the `aviary:agent:*` diagnostics watcher records into Telescope's ephemeral
  event storage. Powers the **Overview** (runs / tokens) and **Tools** (status breakdown + recent
  tool calls) sections.
- **Authoritative spend & usage** — the shared `AGENT_GOVERNANCE_QUERIES` read-model (usage joined to
  model pricing, restart-surviving). Powers the governance sections:
  - **Spend** — total $ + total tokens for the range, a spend-by-model donut, and a daily
    spend/tokens trend (timeseries).
  - **Models** — per-model requests / input+output tokens / cost table.
  - **Actors** — spend share by actor (breakdown) + spend-by-actor table.

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
