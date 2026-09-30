---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent-react": minor
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-codegen": patch
---

Chat protocol gaps found moving a sandboxed runner onto the React client:

- **Error answers reach the hooks.** `AgentHttpError` (and `MediaUploadError`) carry the server's `code`, the parsed `body`, and its `message` as their own `message`, so a failed send, a refused upload or a refused approve/answer shows the server's words. `onHttpError` on `<AgentProvider>` / `AgentClient` sees every error answer before it is thrown (a resume's `404` excepted).
- **A send's `model` is that turn's only.** `chat.models.select(id)` belongs to the conversation it was made in (switching threads drops it), `pinToThread(id)` replaces the pick, and `chat.models.pinned` is the thread's pin.
- **Model lock.** `ModelCatalogView.locked: { model, reason? }` and `AgentCatalogEntry.lockedModel`; the server runs every turn of a locked agent on that model and refuses a send naming another. `useModels().locked` / `chat.models.locked`.
- **Quota soft limit.** `QuotaWindow.warnAt`, `QuotaReport.warning: { period, ratio, reason? }`, `quotaWarning(windows)`, `quota: { limits, warnAt }` on the ledger provider, and `useQuota().warning` / `chat.quota.warning`. `QuotaWindow.usedTokens` is optional, for USD-only budgets.
- **Who answered a question.** `answer`/`skip` take `via`; the settled outcome carries `answeredBy` / `answeredVia` (streamed, persisted, replayed), read into the elicitation block's `outcome`.
- `docs/stream-protocol.md`: error bodies, the regenerate contract (`regenerate: true` never stores the user message again), and how a runner numbers a stream it rebuilds from checkpoints (ids only increase, gaps allowed).
