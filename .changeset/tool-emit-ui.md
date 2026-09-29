---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
'@dudousxd/nestjs-agent-react': minor
'@dudousxd/nestjs-agent-testing': minor
'@dudousxd/nestjs-agent-store-drizzle': minor
'@dudousxd/nestjs-agent-store-mikro-orm': minor
'@dudousxd/nestjs-agent-genui': patch
---

`ctx.emitUi(component, props, { id?, version? })`: a tool pushes a generative-UI component. It
streams live as a `ui` frame (inline, durable, and from the worker serving a dispatched tool step)
and is persisted on the assistant message through the new optional `AgentStore.setMessageUi`
(implemented by the Drizzle, MikroORM and in-memory stores), once per step. The pushes ride the tool
step's journaled result, so a durable replay neither re-streams nor re-persists them; a tool that
pushes nothing journals exactly what it did before. `ui` frames and persisted components gain an
optional `toolCallId`, and a reloaded message places such a component right after its call's tool
part (React: `TranscriptUiBlock.toolCallId`). `ToolSpec.terminal` / `@AiTool({ terminal: true })`
ends the turn after a successful call, settled in the call's `persist:toolcall` checkpoint.

`@dudousxd/nestjs-agent-genui` requires core >= 0.22, where its tools push through `ctx.emitUi` and
`terminal` takes effect.
