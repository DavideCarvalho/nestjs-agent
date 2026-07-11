---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-testing": minor
---

`AgentModule.forRoot()`/`forRootAsync()` gain a `guards` option (`Type<CanActivate>[]`), stamped
uniformly on every mounted controller (chat, threads, tool-call, quota, agents, and attachments) via
`@nestjs/common`'s own `@UseGuards` metadata key with REPLACE semantics — a repeated module
registration never accumulates guards onto the shared controller classes. Guard classes are added to
the module's `providers` for DI.

Tool-related `AgentStreamEvent` frames (`tool-input-start`, `tool-input-available`) now carry an
additive `toolKind: 'read' | 'action'` (collapsing the `agent` delegation kind into `read`, since
that's the distinction a client actually needs — approval-gated or not), stamped from the tool
registry so a UI no longer has to hardcode a tool-name allowlist to know which calls need approval.
Persisted tool calls (`StoredMessage.toolCalls[].kind`) carry the full `ToolKind` (`read | action |
agent`) for the same reason on the thread-read side.

Per-step/message token usage now prices into `costUsd: number | null` — on the `step-finish` stream
frame and the persisted assistant message's `usage` — via the optionally-bound `AGENT_PRICING_STORE`
(a provider-reported cost wins when the model turn reports one). The price list is fetched once per
run and reused for every step, not re-fetched per message. `null` (never a fabricated `0`) when no
pricing store is bound or the model has no price row.

`AgentStore` gains two OPTIONAL SPI methods so existing stores keep compiling: `updateThread(threadId,
{ title?, defaultAgent? })` and `activeRunForThread(threadId)`. Thread read/list payloads add
`defaultAgent: string | null` and `activeRunId: string | null` (`null` when the bound store doesn't
implement the corresponding method). `PATCH /agent/threads/:id` now accepts `{ title?, defaultAgent?
}` (title-only patches still work against any store via the required `setTitle`; a `defaultAgent`
change 501s with a clear message against a store that lacks `updateThread`). `chat()` without an
explicit `agentName` on a thread whose `defaultAgent` is set now uses it — explicit `agentName` still
wins, the module's configured default is the final fallback. `@dudousxd/nestjs-agent-testing`'s
`InMemoryAgentStore` implements both new methods (the latter by reading the same `activeStreamId`
field `setActiveStream` already maintains, now correctly cleared to `null` when a run finishes or
fails instead of staying stamped forever).

New core SPIs, both optional and unbound by default: `ActorDirectory` (`AGENT_ACTOR_DIRECTORY`) —
resolves opaque store `actorRef`s to display labels for governance/dashboard read surfaces — and
`AttachmentStagingStore` (`AGENT_ATTACHMENT_STAGING`) — persists an uploaded file and returns the
`MessageAttachment` to send with the next chat message. When the latter is bound and
`AgentModuleOptions.attachments.upload` is `true` (a static flag — controllers are build-time; DI is
run-time), `POST /agent/attachments` mounts (multipart, single `file` field, buffered in memory,
validated against a configurable size cap / content-type allowlist) under the same path prefix and
guards as the other controllers. `upload: true` with nothing bound to `AGENT_ATTACHMENT_STAGING` fails
boot loudly instead of mounting a controller that would 501 on every request.
