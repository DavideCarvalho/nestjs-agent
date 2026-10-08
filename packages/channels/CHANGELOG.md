# @dudousxd/nestjs-agent-channels

## 0.2.1

### Patch Changes

- [#330](https://github.com/DavideCarvalho/nestjs-agent/pull/330) [`bb635d1`](https://github.com/DavideCarvalho/nestjs-agent/commit/bb635d19a7763024c13421f90aa21ca12c8fe58b) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `whatsmiau()` / `evolutionApi()` read Whatsmiau's incoming messages, which carry no `fromMe` (Go `omitempty`) — a message without `fromMe` counts as incoming only with `status: 'received'`; `fromMe: true` and any other status stay ignored. `key.remoteLid` is recognized as the chat's LID alias. The handler now logs a webhook that parsed to no message on the `AgentChannels` logger (event and reason, no content; `warn` when it looked like a person's message, else `debug`), with the reason from the new optional `ChannelAdapter.ignored(body)`.

  `whatsmiau()` no longer appends the text reply instruction to the buttons message (its buttons render); `evolutionApi({ buttons: true })` still does, and the text fallback (a 4xx, or buttons off) keeps the full instruction.

  A Whatsmiau button press arrives without its id (`buttonsResponseMessage` with only the label): the adapter marks it `buttonWithoutId`, and the handler maps the label to the one still-pending proposal card it sent to that conversation (remembered in the channel store); with several, it falls back to the text decision.

## 0.2.0

### Minor Changes

- [#328](https://github.com/DavideCarvalho/nestjs-agent/pull/328) [`754b0d0`](https://github.com/DavideCarvalho/nestjs-agent/commit/754b0d00c8631a88763539958e6fe11823d81a3c) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Text channels: Brazilian Portuguese texts, self-sufficient buttons, and LID chats replied to by phone.

  - `ptBrChannelTexts` (and `ptBrChannelQuestionTexts`) ship next to `DEFAULT_CHANNEL_TEXTS`. When the agent's `actionProposalText` is `ptBrActionProposalText` (its vocabulary now carries `language: 'pt-BR'` — new optional `TextActionProposalVocabulary.language` in core), each channel starts from the Portuguese texts, so the reply words ("sim"/"não") and what the channel says agree; `texts` overrides that base part by part. `channelTextsFor(vocabulary)` returns the set picked.
  - A buttons message now carries the text reply instruction (`OutboundMessage.instruction`); `evolutionApi` puts it in the buttons description, so a phone that shows no buttons can still answer by text.
  - New `whatsmiau()` adapter, exported next to `evolutionApi`: the same Evolution-format implementation for [Whatsmiau](https://github.com/verbeux-ai/whatsmiau) (built on whatsmeow), with reply buttons on by default (they render; Evolution's Baileys `nativeFlow` buttons were not shown at all on the phone in testing with 2.3.7) and the `/v1` route prefix added to a host-only `url` (a url already ending in `/v1`, `/v2`… is kept). `evolutionApi` keeps buttons off by default.
  - `evolutionApi` LID chats: with `key.remoteJidAlt` (or `senderPn`) present, `conversation` is now the phone jid instead of the `@lid` jid, so replies are sent to the phone number and a chat keeps one conversation id whether it arrives addressed by phone or by LID. Conversation → thread mappings stored under a `@lid` jid start a new thread.

## 0.1.0

### Minor Changes

- [#326](https://github.com/DavideCarvalho/nestjs-agent/pull/326) [`a4a098c`](https://github.com/DavideCarvalho/nestjs-agent/commit/a4a098c61b3246bce716a124b3fa3372b1af6cf5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Text channels — WhatsApp (Evolution API, Cloud API) and Telegram (port of adonis-agora-agent#313).

  New package `@dudousxd/nestjs-agent-channels`: `AgentChannelsModule.forRoot({ channels: [{ adapter, actor, thread, onThreadCreated?, pageContext?, … }], store?, path? })` (or `forRootAsync`) mounts `/channels/<name>` (and `/channels/<name>/:token`) for every channel. Each webhook is verified (`401` otherwise; WhatsApp Cloud's `GET hub.challenge` answered), deduplicated by the provider's message id, acknowledged with `200` at once and answered in the background (`AgentChannelsService.drain()`; drained on module destroy). The turn is sent with text-only capabilities and `pageContext.channel = { name, conversation }`; text decisions get their reply; the reply (prose and component `fallbackText`) is converted to the channel's markdown (`toChannelMarkdown`: WhatsApp, Telegram MarkdownV2, none) and split at its length limit (`splitMessage`). Media is downloaded within the attachment limits, staged with `AgentService.stageAttachment` and attached as `{ mediaId }` — or refused with `texts.mediaRefused`. Questions (`ask`, intakes) go out as numbered text one at a time; the next messages answer them (`parseChannelAnswer`, `skip`), and `questionTimeoutMs` skips them. Pending proposals get Confirm/Cancel buttons (`agora:approve|reject:<last 32 of the id>`) decided through `AgentService.decideActionProposal` with `via` = the channel's name, or a text instruction in the configured `actionProposalText` vocabulary; an approved proposal's outcome is relayed after `outcomeTimeoutMs`, and later ones through the worker's settled hook, each once. Adapters: `evolutionApi`, `whatsappCloud` (`X-Hub-Signature-256` over the raw body — create the app with `rawBody: true`), `telegram`; any `ChannelAdapter` works. `path: false` + `AgentChannelsService.handle(name, req, res)` serve the webhook from a controller of your own.

  - core: the `ChannelStore` SPI (`claim` / `get` / `set` / `delete` with TTLs, optional `purgeExpired`), `InMemoryChannelStore`, and the `AGENT_CHANNEL_STORE` token.
  - nestjs: `AgentService.actionApprovalMode()`, `actionProposalVocabulary()`, `actionProposalReply(result, decision)`, `listActionProposals(actor, threadId)`, `attachmentLimits()` and `stageAttachment(actor, file)` (the upload route's checks: `501` / `415` / `413`); `ActionProposalWorkerService.onSettled(listener)` and `actionProposalWorker.onSettled` run after each proposal the worker settles; `ActionProposalService.textVocabulary()`.
  - store-drizzle, store-mikro-orm: `DrizzleChannelStore` / `MikroOrmChannelStore` on a new `agent_channel_state` table (created by `ensureAgentSchema`; MikroORM: also in `agentEntities()` / `agentManagedTables()`), bound to `AGENT_CHANNEL_STORE` by the store modules — the channels' default store when present.
  - transport-redis: `RedisChannelStore` (`SET … PX … NX`), taking an `ioredis` client as is.
  - testing: `CHANNEL_STORE_CONTRACT`, the cases every channel store runs.
