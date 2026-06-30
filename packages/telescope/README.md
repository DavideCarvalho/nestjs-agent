# `@dudousxd/nestjs-agent-telescope`

> 🪺 Part of the [Aviary](https://davidecarvalho.github.io/aviary) · an "Agent" tab for [`@dudousxd/nestjs-telescope`](https://www.npmjs.com/package/@dudousxd/nestjs-telescope).

Adds an **Agent** dashboard to Telescope. It subscribes to the `aviary:agent:*` diagnostics channel
and surfaces runs, messages, tool calls, delegations, quota events, and cost — no instrumentation in
your code.

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
