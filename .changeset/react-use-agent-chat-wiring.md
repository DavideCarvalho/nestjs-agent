---
"@dudousxd/nestjs-agent-react": minor
---

`useAgentChat` does the wiring: history, resume, quota, models, composer and a bound transcript.

- A `threadId` without `initialMessages` loads the thread's history by itself (`history: false` opts out; `chat.isLoadingHistory` / `chat.historyError`), and changing `threadId` switches the chat to that thread cleanly. Passing back the thread the chat itself just created (URL sync) keeps the live conversation.
- `resume` now defaults to `true`: a turn still streaming on the thread is re-attached (its already-persisted rows are left to the stream, so nothing is drawn twice).
- Automatic quota gate: the chat reads `GET <base>/quota` when the backend implements `getQuota` (`quota: false` skips it) and refuses sends while a window is exhausted. `blocked` stays as an override (`null` never blocks). `chat.quota` is the `useQuota` state; `chat.blocked` the window blocking sends.
- `chat.models`: `{ list, providers, selected, select(id), pinToThread(id), isLoading, error }`, loaded the first time `list`/`providers` is read. A pin asked for before the first send lands on the thread that send creates.
- `chat.transcript`: `useChatTranscript` bound to the chat — approve/reject/answer/skip, stop, fork, regenerate, the tool catalog — overridable with `useAgentChat({ transcript: { … } })`.
- `chat.composer`: `{ text, setText, files, canSend, blockedBy, submit() }` — attaches the ready files as refs, clears draft and files after sending, blocks while uploading / busy / quota-blocked. `useAgentChat({ composer: { accept, maxBytes, maxFiles } })`.
- Approval and question-set blocks are functional by default: `useChatTranscript` (and so `MessageList`, the registry's `AgentChat`) settles them through the in-scope backend when no handler is passed; pass `null` to opt a decision out.
- Messages carry `metadata.createdAt` (replayed rows and live turns) and replayed single rows their `metadata.usage`, which `useChatTranscript` reads by default for `timestamp` / `usage`.

**Breaking**

- Transcript callbacks take one object: `onApprove({ toolCallId, remember? })`, `onReject({ toolCallId, reason? })`, `onAnswer({ toolCallId, answers })`, `onSkip({ toolCallId })`, `onEditSubmit({ messageId, text })`, `onFork({ messageId })`, `onRegenerate({ messageId })` — the same shape as `chat.approve`/`reject`/`answer`/`skip`, so they can be passed straight through. Same for `MessageList` / `MessageItem` props (`MessageItem`'s `onEditSubmit` now gets `{ messageId, text }`, `onRegenerate` `{ messageId }`).
- Removed from `useAgentChat`'s return: `threads`, `loadThreads`, `deleteThread`, `renameThread` (use `useThreads()`), `quota`/`loadQuota` v1 (`chat.quota` is now the `useQuota` state), `loadThread` (history loads itself; `chat.backend.getThread` for a manual read), `setThreadModel` (→ `chat.models.pinToThread`), `forkThread(threadId, messageId)` (→ `chat.fork({ messageId, threadId? })`), `truncateFromMessage(threadId, messageId)` (→ `chat.truncateFrom({ messageId, threadId? })`), `promoteThread(id)` (→ `chat.promote({ threadId? })`).
- `resume` defaults to `true` (was `false`); `useAgentChat({ threadId })` now reads the thread on mount.
- `AgentClient.getQuotaToday`, `AgentBackend.getQuotaToday` and the `QuotaToday` type are removed (use `getQuota` / `useQuota`); `AgentClient.renameThread` is removed (`updateThread(id, { title })`).
- `storedMessageToUiMessage` / `storedThreadToUiMessages` now always stamp `metadata.createdAt` (and a single row's `usage`), so a replayed message is no longer metadata-free.
