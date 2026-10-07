---
"@dudousxd/nestjs-agent-channels": minor
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-testing": minor
"@dudousxd/nestjs-agent-store-drizzle": minor
"@dudousxd/nestjs-agent-store-mikro-orm": minor
"@dudousxd/nestjs-agent-transport-redis": minor
---

Text channels — WhatsApp (Evolution API, Cloud API) and Telegram (port of adonis-agora-agent#313).

New package `@dudousxd/nestjs-agent-channels`: `AgentChannelsModule.forRoot({ channels: [{ adapter, actor, thread, onThreadCreated?, pageContext?, … }], store?, path? })` (or `forRootAsync`) mounts `/channels/<name>` (and `/channels/<name>/:token`) for every channel. Each webhook is verified (`401` otherwise; WhatsApp Cloud's `GET hub.challenge` answered), deduplicated by the provider's message id, acknowledged with `200` at once and answered in the background (`AgentChannelsService.drain()`; drained on module destroy). The turn is sent with text-only capabilities and `pageContext.channel = { name, conversation }`; text decisions get their reply; the reply (prose and component `fallbackText`) is converted to the channel's markdown (`toChannelMarkdown`: WhatsApp, Telegram MarkdownV2, none) and split at its length limit (`splitMessage`). Media is downloaded within the attachment limits, staged with `AgentService.stageAttachment` and attached as `{ mediaId }` — or refused with `texts.mediaRefused`. Questions (`ask`, intakes) go out as numbered text one at a time; the next messages answer them (`parseChannelAnswer`, `skip`), and `questionTimeoutMs` skips them. Pending proposals get Confirm/Cancel buttons (`agora:approve|reject:<last 32 of the id>`) decided through `AgentService.decideActionProposal` with `via` = the channel's name, or a text instruction in the configured `actionProposalText` vocabulary; an approved proposal's outcome is relayed after `outcomeTimeoutMs`, and later ones through the worker's settled hook, each once. Adapters: `evolutionApi`, `whatsappCloud` (`X-Hub-Signature-256` over the raw body — create the app with `rawBody: true`), `telegram`; any `ChannelAdapter` works. `path: false` + `AgentChannelsService.handle(name, req, res)` serve the webhook from a controller of your own.

- core: the `ChannelStore` SPI (`claim` / `get` / `set` / `delete` with TTLs, optional `purgeExpired`), `InMemoryChannelStore`, and the `AGENT_CHANNEL_STORE` token.
- nestjs: `AgentService.actionApprovalMode()`, `actionProposalVocabulary()`, `actionProposalReply(result, decision)`, `listActionProposals(actor, threadId)`, `attachmentLimits()` and `stageAttachment(actor, file)` (the upload route's checks: `501` / `415` / `413`); `ActionProposalWorkerService.onSettled(listener)` and `actionProposalWorker.onSettled` run after each proposal the worker settles; `ActionProposalService.textVocabulary()`.
- store-drizzle, store-mikro-orm: `DrizzleChannelStore` / `MikroOrmChannelStore` on a new `agent_channel_state` table (created by `ensureAgentSchema`; MikroORM: also in `agentEntities()` / `agentManagedTables()`), bound to `AGENT_CHANNEL_STORE` by the store modules — the channels' default store when present.
- transport-redis: `RedisChannelStore` (`SET … PX … NX`), taking an `ioredis` client as is.
- testing: `CHANNEL_STORE_CONTRACT`, the cases every channel store runs.
