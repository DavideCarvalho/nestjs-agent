# `@dudousxd/nestjs-agent-core`

> 🪺 Part of the [Aviary](https://davidecarvalho.github.io/aviary) · the framework-agnostic core of [`@dudousxd/nestjs-agent`](https://www.npmjs.com/package/@dudousxd/nestjs-agent).

The portable heart of the agent library — no NestJS, no I/O. It holds the **SPIs** (`ModelProvider`,
`AgentStore`, `TokenStreamSink`, `RolesPolicy`, `QuotaStore`, `AgentRunner`), the `ToolRegistry`, the
`AgentRegistry`, personas, the `aviary:agent:*` diagnostics channel, and `runAgentLoop` — the model↔tool
loop that streams to a sink while routing every side-effect through a `hooks.step` checkpoint so it can
run inline or as a durable workflow.

You rarely depend on this directly — install [`@dudousxd/nestjs-agent`](https://www.npmjs.com/package/@dudousxd/nestjs-agent),
which re-exports the whole core surface. Reach for it when implementing a custom adapter (a model
provider, a store, a sink) against the SPIs.

```ts
import type { ModelProvider, AgentStore, ToolSpec, RolesPolicy } from '@dudousxd/nestjs-agent-core';
```

## Key types

- `ToolSpec` — `{ name, kind: 'read' | 'action' | 'agent', description, inputSchema, roles?, ability?, targetAgent? }`
- `AgentDefinition` — a named agent (`systemPrompt`, `tools`, `delegatesTo`, `personas`, …) for multi-agent setups
- `RolesPolicy.can(actor, tool): boolean | Promise<boolean>` — the tool authorization seam
- `runAgentLoop(deps, input, hooks)` — the loop; the NestJS package drives it from both runners

## License

MIT © Davide Carvalho
