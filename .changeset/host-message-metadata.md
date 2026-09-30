---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent-react": minor
---

Host message metadata and nested-call replay, for runners that are not this library's loop:

- `StoredMessage.metadata` (host-defined, e.g. the model that answered or the error a turn ended with) is replayed into the client message's `metadata`, under the library's own keys.
- A new `message-metadata` stream frame carries the same facts live and maps to the AI SDK's `message-metadata` chunk.
- `ToolCallRequest.parentId` is replayed as the tool part's `toolMetadata.parentId`, so a reloaded thread nests code-mode inner calls the way the live stream did.
