---
"@dudousxd/nestjs-agent-core": patch
"@dudousxd/nestjs-agent": patch
"@dudousxd/nestjs-agent-react": patch
---

AG-UI: a React app on `agUiChatStream` now gets what the native stream gives it.

- Attachments: the send's staged `attachments` (`{ mediaId }`) go out as `file` content parts with `provider: 'nestjs-agent'` (`AG_UI_MEDIA_PROVIDER`); `POST <path>/ag-ui` resolves them for the caller exactly like the native `chat` route (a mediaId another actor owns is refused with 403). Before, the composer's attachments were silently dropped.
- Regenerate: `regenerate: true` rides `forwardedProps` and the route re-runs the thread's last exchange instead of appending a new turn (400 on a thread that does not exist yet).
- Question sets: `agora.elicitation` now carries the tool-call `id`, and the React client turns it into the native `elicitation` frame, so the question form renders.
- Per-step usage: `agora.step-usage` is folded into the preceding `step-finish` (`usage`, `costUsd`, `reasoningMs`) instead of being ignored.
- Tool kinds: `TOOL_CALL_START.metadata` carries `agora.toolKind` (and `agora.parentId`); the React client uses them instead of marking every call `read`, so approval affordances and nested calls work over AG-UI.
