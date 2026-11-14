# `@dudousxd/nestjs-agent-codegen`

> 🪺 Part of the [Aviary](https://davidecarvalho.github.io/aviary) · a [`@dudousxd/nestjs-codegen`](https://www.npmjs.com/package/@dudousxd/nestjs-codegen) extension for [`@dudousxd/nestjs-agent`](https://www.npmjs.com/package/@dudousxd/nestjs-agent).

Emits the agent's JSON REST routes — threads, agent catalog, tool-call approve/reject, action
proposals (list/approve/reject), quota, the message queue, and cancel — into your generated `api.ts`, so they're available as a typed client / TanStack hooks in
your frontend. The agent controllers live in `node_modules` where static AST discovery can't see
them, so this extension injects the routes directly.

The streaming `POST /agent/chat` + `GET /agent/chat/:runId/stream` SSE endpoints are intentionally
omitted — use [`@dudousxd/nestjs-agent-react`](https://www.npmjs.com/package/@dudousxd/nestjs-agent-react)'s
`useAgentChat` (a Vercel AI SDK transport) for those.

## Install

```bash
pnpm add -D @dudousxd/nestjs-agent-codegen
```

## Use

```ts
// nestjs-inertia.config.ts (or your codegen config)
import { defineConfig } from '@dudousxd/nestjs-codegen';
import { nestjsAgentCodegen } from '@dudousxd/nestjs-agent-codegen';

export default defineConfig({
  extensions: [nestjsAgentCodegen({ basePath: '/api' })],
});
```

Generates `api.agent.threads.list()`, `api.agent.threads.fork()`, `api.agent.toolCall.approve()`,
`api.agent.actionProposals.approve()`, `api.agent.quota.report()`, `api.agent.config()`, etc.

List routes answer the Aviary list wire: `{ data }` (`agents`, `threads`, `skills`, `tools`,
`memories`, `attachments`; `models` adds `default`/`locked` beside `data`), filtered with flat
`filter[...]` query keys (`{ 'filter[agent]': 'support' }`) and sized with `size` where they take one.
`api.agent.actionProposals.list()` returns one cursor page, `{ data, meta: { nextCursor, … } }`: pass
`meta.nextCursor` back as `after` until it is `null` (the React `AgentClient.listActionProposals`
does this for you).

Options: `basePath` (controller mount prefix) and `name` (client namespace, default `agent`).

## License

MIT © Davide Carvalho
