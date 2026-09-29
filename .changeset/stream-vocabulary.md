---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent-react': minor
---

Stream vocabulary for generative UI, titles, approval metadata and nested tool calls — usable by runners that are not this library's loop (contract: `docs/stream-protocol.md`).

- core: `AgentStreamEvent` gains `ui` (`{ id, component, props, version? }` — a server-pushed component addressed by registry key, not by tool name), `title` (`{ title }`), `approval-requested` (`{ id, approver, expiresAt?, reason? }` — who has to settle a parked action call, and until when) and an optional `parentId` on `tool-input-start`/`tool-input-available` for nested calls. New payload types `AgentUiComponent` and `AgentApprovalRequest`. Readers must tolerate unknown kinds.
- react: `AgentChatTransport` maps `ui` → `data-ui` part (keyed by component id, updated in place; closes the open prose so later text renders after it), `approval-requested` → `data-approval-requested` part plus the AI SDK's native `tool-approval-request` (the tool part moves to `state: 'approval-requested'`; only for calls the stream announced), `title`/`cancelled` → transient `data-title`/`data-cancelled`, and forwards any unknown kind as `data-<kind>` instead of dropping it. `parentId` rides `toolMetadata` and survives the later input frame.
- react: `useAgentChat` gains `onData` and `onTitle`.
- react: the transcript model adds a `ui` block, and every `TranscriptToolCall` now carries `toolKind`, `parentId`, `children` and `approval` (`{ approver, expiresAt, reason }` or `null`); `TranscriptToolBlock.roots` is the calls as a tree. `MessageItem`/`MessageList` take a `renderUi` slot (unstyled, `data-slot="ui"`); pushed components are not drawn without one.
