# @dudousxd/nestjs-agent-transport-redis

## 0.5.0

### Minor Changes

- [#326](https://github.com/DavideCarvalho/nestjs-agent/pull/326) [`a4a098c`](https://github.com/DavideCarvalho/nestjs-agent/commit/a4a098c61b3246bce716a124b3fa3372b1af6cf5) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Text channels — WhatsApp (Evolution API, Cloud API) and Telegram (port of adonis-agora-agent#313).

  New package `@dudousxd/nestjs-agent-channels`: `AgentChannelsModule.forRoot({ channels: [{ adapter, actor, thread, onThreadCreated?, pageContext?, … }], store?, path? })` (or `forRootAsync`) mounts `/channels/<name>` (and `/channels/<name>/:token`) for every channel. Each webhook is verified (`401` otherwise; WhatsApp Cloud's `GET hub.challenge` answered), deduplicated by the provider's message id, acknowledged with `200` at once and answered in the background (`AgentChannelsService.drain()`; drained on module destroy). The turn is sent with text-only capabilities and `pageContext.channel = { name, conversation }`; text decisions get their reply; the reply (prose and component `fallbackText`) is converted to the channel's markdown (`toChannelMarkdown`: WhatsApp, Telegram MarkdownV2, none) and split at its length limit (`splitMessage`). Media is downloaded within the attachment limits, staged with `AgentService.stageAttachment` and attached as `{ mediaId }` — or refused with `texts.mediaRefused`. Questions (`ask`, intakes) go out as numbered text one at a time; the next messages answer them (`parseChannelAnswer`, `skip`), and `questionTimeoutMs` skips them. Pending proposals get Confirm/Cancel buttons (`agora:approve|reject:<last 32 of the id>`) decided through `AgentService.decideActionProposal` with `via` = the channel's name, or a text instruction in the configured `actionProposalText` vocabulary; an approved proposal's outcome is relayed after `outcomeTimeoutMs`, and later ones through the worker's settled hook, each once. Adapters: `evolutionApi`, `whatsappCloud` (`X-Hub-Signature-256` over the raw body — create the app with `rawBody: true`), `telegram`; any `ChannelAdapter` works. `path: false` + `AgentChannelsService.handle(name, req, res)` serve the webhook from a controller of your own.

  - core: the `ChannelStore` SPI (`claim` / `get` / `set` / `delete` with TTLs, optional `purgeExpired`), `InMemoryChannelStore`, and the `AGENT_CHANNEL_STORE` token.
  - nestjs: `AgentService.actionApprovalMode()`, `actionProposalVocabulary()`, `actionProposalReply(result, decision)`, `listActionProposals(actor, threadId)`, `attachmentLimits()` and `stageAttachment(actor, file)` (the upload route's checks: `501` / `415` / `413`); `ActionProposalWorkerService.onSettled(listener)` and `actionProposalWorker.onSettled` run after each proposal the worker settles; `ActionProposalService.textVocabulary()`.
  - store-drizzle, store-mikro-orm: `DrizzleChannelStore` / `MikroOrmChannelStore` on a new `agent_channel_state` table (created by `ensureAgentSchema`; MikroORM: also in `agentEntities()` / `agentManagedTables()`), bound to `AGENT_CHANNEL_STORE` by the store modules — the channels' default store when present.
  - transport-redis: `RedisChannelStore` (`SET … PX … NX`), taking an `ioredis` client as is.
  - testing: `CHANNEL_STORE_CONTRACT`, the cases every channel store runs.

## 0.4.0

### Minor Changes

- [#319](https://github.com/DavideCarvalho/nestjs-agent/pull/319) [`6b7de84`](https://github.com/DavideCarvalho/nestjs-agent/commit/6b7de84eca7dd094baf21a19be8144d8ae2409da) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Redis stream keys now expire.

  - `@dudousxd/nestjs-agent-transport-redis`: `RedisTokenStreamSink` takes a `ttlSeconds` option (default 3600; `0` keeps keys until `close()`). Nothing calls `close()` on its own, so before this, every run's `:chunks` and `:state` keys stayed in Redis forever. The TTL slides from the run's last write and is set on both keys when the run ends or fails. `RedisStreamClient` gains an `expire(key, seconds)` method. An adapter that doesn't implement it still streams, but its keys never expire.
  - `@dudousxd/nestjs-agent/sink-redis`: the TTL is now also re-armed on every write, so a run that crashes without ending still expires. `ttlSeconds: 0` now means "keep until `close()`". Before, it sent `EXPIRE 0`, which deleted the stream when the run ended.

## 0.3.11

### Patch Changes

- [#59](https://github.com/DavideCarvalho/nestjs-agent/pull/59) [`d115cb7`](https://github.com/DavideCarvalho/nestjs-agent/commit/d115cb7973aafa539eafbb1e488259044a562069) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Stop a `core` minor from promoting half the monorepo to 1.0.0.

  Five packages declared their peer dependency on `@dudousxd/nestjs-agent-core` as `workspace:*`. Changesets treats a peer-dependency bump as breaking for the dependent, and "breaking" on a `0.x` package means `1.0.0` — so the moment `core` took a minor, `ai-sdk`, `rag`, `store-mikro-orm`, `testing` and `transport-redis` were all queued to publish as `1.0.0`. `rag-media` went with them by cascade: its own range on `core` was correct, but its `>=0.4.0 <1.0.0` on `rag` stopped being satisfied once `rag` majored.

  The ranges are now `>=0.10.0 <1.0.0`, matching what `dashboard` and `rag-media` already declared. `onlyUpdatePeerDependentsWhenOutOfRange` is already set in the changesets config, and with a range that a `0.11.0` core still satisfies it does its job. `dashboard` is the control: it peer-depends on `core` too, and it was the one package that did _not_ major, because its range was written this way from the start.

  Verified by running `changeset version` against the same set of changesets before and after: six `1.0.0` bumps become the minors and patches those changesets actually asked for.

  Consumers would have felt this as silence rather than breakage. A dependant on `^0.7.0` of `rag` does not match `1.0.0`, so it simply stops receiving updates, with nothing failing anywhere to say so.

## 0.3.10

### Patch Changes

- Updated dependencies [[`70114eb`](https://github.com/DavideCarvalho/nestjs-agent/commit/70114ebb9a7a3702d2efdb11e0dea6956a7ba8db)]:
  - @dudousxd/nestjs-agent-core@0.10.0

## 0.3.9

### Patch Changes

- Updated dependencies [[`107fcc2`](https://github.com/DavideCarvalho/nestjs-agent/commit/107fcc2c0079f97c3cc9ff8c83f2dc41070244d5)]:
  - @dudousxd/nestjs-agent-core@0.9.0

## 0.3.8

### Patch Changes

- Updated dependencies [[`3d256d4`](https://github.com/DavideCarvalho/nestjs-agent/commit/3d256d4027c7ad819f8ec908425d52887e67da3f)]:
  - @dudousxd/nestjs-agent-core@0.8.0

## 0.3.7

### Patch Changes

- Updated dependencies [[`6263338`](https://github.com/DavideCarvalho/nestjs-agent/commit/6263338cf86df7b51cb082d5d2d575987cd13383)]:
  - @dudousxd/nestjs-agent-core@0.7.0

## 0.3.6

### Patch Changes

- Updated dependencies [[`eb3aaff`](https://github.com/DavideCarvalho/nestjs-agent/commit/eb3aaff531cc923de1d0bccebb2b0690b4c92263), [`781a30f`](https://github.com/DavideCarvalho/nestjs-agent/commit/781a30f6579d5b9a69f341b8eeac02c273dbb8a1)]:
  - @dudousxd/nestjs-agent-core@0.6.0

## 0.3.5

### Patch Changes

- Updated dependencies [[`1c44152`](https://github.com/DavideCarvalho/nestjs-agent/commit/1c4415295a6280527e762f13e6aed48099ae5ca5), [`1c44152`](https://github.com/DavideCarvalho/nestjs-agent/commit/1c4415295a6280527e762f13e6aed48099ae5ca5)]:
  - @dudousxd/nestjs-agent-core@0.5.0

## 0.3.4

### Patch Changes

- Updated dependencies [[`abb32bc`](https://github.com/DavideCarvalho/nestjs-agent/commit/abb32bc0396c65a59ee2b92a1a8b07d772215e31)]:
  - @dudousxd/nestjs-agent-core@0.4.0

## 0.3.3

### Patch Changes

- Updated dependencies [[`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46), [`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46), [`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46)]:
  - @dudousxd/nestjs-agent-core@0.3.3

## 0.3.2

### Patch Changes

- Updated dependencies
- Updated dependencies [ad8e446]
  - @dudousxd/nestjs-agent-core@0.3.2

## 0.3.1

### Patch Changes

- Updated dependencies [[`60dcc7d`](https://github.com/DavideCarvalho/nestjs-agent/commit/60dcc7db3764a7d60cb6e4d586f1c0fe7b05ee04)]:
  - @dudousxd/nestjs-agent-core@0.3.1
