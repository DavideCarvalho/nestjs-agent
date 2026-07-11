---
"@dudousxd/nestjs-agent-react": minor
---

Ports the `StoredMessage → UIMessage` adapter consumers were hand-writing into the package as
`storedMessageToUiMessage()`: text/attachment/tool parts, pairing a tool call with its result by id
(falling back to `input-available` when a call never finished), and carrying the store's `toolKind`
through as `toolMetadata` so a UI can gate approval affordances on `kind === 'action'` without
hardcoding tool names.

`AgentChatTransport` now forwards `toolKind` from `tool-input-start`/`tool-input-available` stream
frames onto the emitted chunks' `toolMetadata`, and surfaces a step's `costUsd` (from `step-finish`)
as a `message-metadata` chunk merged onto `message.metadata`. Both are additive and backend-version
tolerant — an older backend that omits the fields never crashes the client.

`useAgentChat` gains a `resume` option: when `true`, the hook fetches the thread on (re)mount and,
if it carries a live `activeRunId`, automatically attaches to that run's stream — no more manually
plumbing `resumeRunId` from a separate thread fetch. The resolved `activeRunId` is exposed on the
hook's return value. `AgentClient` gains `updateThread(id, { title?, defaultAgent? })` (general
`PATCH /agent/threads/:id`, which `renameThread` now delegates to) and `uploadAttachment(file)`
(multipart `POST /agent/attachments`, returning a `MessageAttachment` ready to ride a send's
`attachments`).
