---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-react": minor
"@dudousxd/nestjs-agent-store-drizzle": minor
"@dudousxd/nestjs-agent-store-mikro-orm": minor
"@dudousxd/nestjs-agent-codegen": minor
---

One way to do each thing: quota, attachment limits, upload route, client config.

- **Quota** is a single option: `quota: { limits: { day?, month? } }` (ceilings on the built-in ledger provider) or `quota: yourQuotaProvider`. Either way `GET <base>/quota` reports it and a blocked send is refused with `429`; omitted, usage is reported and never enforced.
- **`GET <base>/config`** serves what clients used to repeat: `{ attachments: { enabled, upload: 'multipart' | 'resumable' | null, maxBytes, allowedContentTypes, maxPerMessage }, models: { enabled }, quota: { enforced }, identity: { anonymous } }` (`AgentClientConfig` in core). React: `AgentBackend.getConfig` / `AgentClient.getConfig`, `useAgentConfig()`, and `useAttachments` (so `chat.composer.files`) takes `accept` / `maxBytes` / `maxFiles` defaults from it.
- **Attachment limits** have one source: the staging store's `describe()` when it declares them (`AgentMediaAttachmentsModule` does — its `maxBytes` / `allowedContentTypes` are then the only limits in force), else `AgentModule`'s `attachments: { maxBytes, allowedContentTypes }`, else the defaults. New optional SPI member `AttachmentStagingStore.describe()`.
- **Upload route**: `POST <base>/attachments` is mounted always and live whenever a staging store is bound (`501` otherwise); with `AgentMediaAttachmentsModule` the resumable `<base>/attachments/uploads` routes are the documented path (`config.attachments.upload === 'resumable'`).
- **History attachments**: `GET <base>/threads/:id` re-mints each attachment's url from the staging store by `mediaId` on every read, so an old turn's presigned link never shows expired.
- **One run field**: a thread's running turn is `activeRunId` everywhere (summary and detail).

**Breaking**

- Removed `AgentModuleOptions.quotaLimitTokens`, `quotaLimits`, `quotaProvider` and the `QuotaStore`-typed `quota`; `LedgerQuotaStore` is removed and `LedgerQuotaProvider`'s constructor is `(store, limits?)`. The module no longer binds `AGENT_QUOTA_STORE`, so the loop's own `quota:check`/`quota:bump` steps no longer run under `AgentModule` (enforcement is the send gate) — drain in-flight durable runs of a deployment that used `quotaLimitTokens` or a `quota` store before upgrading. Migrate: `quotaLimitTokens: N` → `quota: { limits: { day: { tokens: N } } }`; `quotaLimits: L` → `quota: { limits: L }`; `quotaProvider: P` → `quota: P`.
- Removed `GET <base>/quota/today` and `AgentService.quotaToday` (use `GET <base>/quota`).
- Removed `attachments.upload` (`AgentModuleOptions`) and `attachmentsUpload` (`forRootAsync`): the upload route follows the bound staging store. `DEFAULT_MAX_ATTACHMENT_BYTES` / `DEFAULT_ALLOWED_ATTACHMENT_CONTENT_TYPES` now export from the package root's `attachment-limits` (same names).
- `POST <base>/chat` accepts attachments only as `{ mediaId }` refs — an entry with any other key is refused with `400` (it used to be trimmed). React: `AttachmentsState.attachments` is removed; send `files.refs` (each item still carries its `attachment` for display).
- `ThreadDetail.activeStreamId` is removed from core and every store's `getThread` — read `activeRunId`.
