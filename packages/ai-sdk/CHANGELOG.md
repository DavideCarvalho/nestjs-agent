# @dudousxd/nestjs-agent-ai-sdk

## 0.6.0

### Minor Changes

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Constrain a turn's answer to a schema.

  Every answer this library produced was free text, so the only way to get a typed value back out of a
  turn was to declare a TOOL whose whole job was to receive it — which is how the main consumer ended
  up with a `renderResult` tool that renders nothing and exists purely to smuggle structure past the
  prose.

  `@Agent({ outputSchema })` takes any [Standard Schema](https://standardschema.dev) (Zod, Valibot,
  ArkType). The validated value comes back as `object` on the run's result, typed when the loop is
  called directly (`runAgentLoop<T>`), and is recorded on the assistant message as a synthetic
  `structured_output` tool call — the device inject-mode retrieval already uses, so it reaches every
  thread reader and the UI's existing tool-output rendering without a store gaining a column. It is
  declared on the agent rather than per request because a schema is a live object and `AgentRunInput`
  crosses a JSON boundary on its way into a durable workflow.

  **How it composes with tool calling: as a separate formatting pass, always.** The turn runs its
  model→tools iteration exactly as it would without a schema; once a step comes back with no tool
  calls, one extra non-streamed call (`structured:<step>:<n>`, `tools: []`, `outputSchema` set)
  restates that answer as the schema. Most providers cannot serve a response format and a tool set in
  the same request. Skipping the pass for an agent that happens to have no tools would be cheaper and
  is deliberately not done: that decision would read the tool registry of whichever process is
  replaying, which is how a resumed run ends up asking for a checkpoint position its history has no
  room for. So the pass is unconditional, and it costs one model call per turn, billed as its own
  `structured_output` usage row.

  The pass restates the answer that survived the output gate, never the model's raw reply, and is told
  to use only what the conversation already contains — the structured value is a translation of the
  answer, not a second route out of the model.

  **An answer that fails the schema is a defined outcome.** Up to `outputRepairAttempts` further calls
  (default 1) re-ask with the previous attempt's validation issues attached; after that the run fails
  with a `StructuredOutputError` carrying the issues, the text that failed them, and the attempt count,
  under its own `structured_output_invalid` stream error code. Bounded because a model that cannot
  satisfy a schema usually cannot satisfy it on the fourth try either, and every attempt is billed. Set
  `outputRepairAttempts: 0` to fail on the first invalid reply.

  `ModelTurnArgs` gains `outputSchema` and `ModelTurnResult` gains `object`. The AI SDK adapter maps
  the schema onto `streamText`'s `output: Output.object(...)` so the provider constrains generation,
  and passes its parsed value back — but the loop validates it regardless. "The provider says it
  matched" is not the same claim as "it matches", and a provider that ignored the schema has to fail
  where the failure is repairable rather than downstream. An adapter that cannot constrain generation
  at all still works: the loop reads the JSON out of the reply text, fences and lead-in prose included.

  `UsagePurpose` gains `'structured_output'`. Both shipped stores persist `purpose` as text, so no
  schema change is needed. A consumer who declares no `outputSchema` sees no new checkpoint, no extra
  call, and no change to the loop's checkpoint sequence.

## 0.5.3

### Patch Changes

- [#59](https://github.com/DavideCarvalho/nestjs-agent/pull/59) [`d115cb7`](https://github.com/DavideCarvalho/nestjs-agent/commit/d115cb7973aafa539eafbb1e488259044a562069) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Stop a `core` minor from promoting half the monorepo to 1.0.0.

  Five packages declared their peer dependency on `@dudousxd/nestjs-agent-core` as `workspace:*`. Changesets treats a peer-dependency bump as breaking for the dependent, and "breaking" on a `0.x` package means `1.0.0` — so the moment `core` took a minor, `ai-sdk`, `rag`, `store-mikro-orm`, `testing` and `transport-redis` were all queued to publish as `1.0.0`. `rag-media` went with them by cascade: its own range on `core` was correct, but its `>=0.4.0 <1.0.0` on `rag` stopped being satisfied once `rag` majored.

  The ranges are now `>=0.10.0 <1.0.0`, matching what `dashboard` and `rag-media` already declared. `onlyUpdatePeerDependentsWhenOutOfRange` is already set in the changesets config, and with a range that a `0.11.0` core still satisfies it does its job. `dashboard` is the control: it peer-depends on `core` too, and it was the one package that did _not_ major, because its range was written this way from the start.

  Verified by running `changeset version` against the same set of changesets before and after: six `1.0.0` bumps become the minors and patches those changesets actually asked for.

  Consumers would have felt this as silence rather than breakage. A dependant on `^0.7.0` of `rag` does not match `1.0.0`, so it simply stops receiving updates, with nothing failing anywhere to say so.

## 0.5.2

### Patch Changes

- Updated dependencies [[`70114eb`](https://github.com/DavideCarvalho/nestjs-agent/commit/70114ebb9a7a3702d2efdb11e0dea6956a7ba8db)]:
  - @dudousxd/nestjs-agent-core@0.10.0

## 0.5.1

### Patch Changes

- Updated dependencies [[`107fcc2`](https://github.com/DavideCarvalho/nestjs-agent/commit/107fcc2c0079f97c3cc9ff8c83f2dc41070244d5)]:
  - @dudousxd/nestjs-agent-core@0.9.0

## 0.5.0

### Minor Changes

- [`3d256d4`](https://github.com/DavideCarvalho/nestjs-agent/commit/3d256d4027c7ad819f8ec908425d52887e67da3f) - `attachmentFetchDownloader()` — the ready-made `experimental_download` for hosts whose attachment
  staging presigns non-public URLs (local MinIO in dev, VPC-only S3): plain-fetches unsupported URLs
  with no hostname policy, leaves model-supported URLs to the provider, errors carry status +
  hostname (never the full presigned URL). One line instead of the fetch boilerplate every such host
  was about to copy. Safe only because agent attachment URLs come from the host's own staging SPI.

### Patch Changes

- Updated dependencies [[`3d256d4`](https://github.com/DavideCarvalho/nestjs-agent/commit/3d256d4027c7ad819f8ec908425d52887e67da3f)]:
  - @dudousxd/nestjs-agent-core@0.8.0

## 0.4.3

### Patch Changes

- [`6263338`](https://github.com/DavideCarvalho/nestjs-agent/commit/6263338cf86df7b51cb082d5d2d575987cd13383) - `AiSdkModelOptions` accepts `experimental_download` — the AI SDK's default downloader refuses
  localhost/private hostnames (SSRF guard), so attachment parts staged against a local object store
  (MinIO in dev) killed the model call with `AI_DownloadError: URL with hostname localhost is not
allowed`. Hosts whose staging presigns non-public URLs supply their own fetch; attachment URLs come
  from the host's own staging SPI, never user input.
- Updated dependencies [[`6263338`](https://github.com/DavideCarvalho/nestjs-agent/commit/6263338cf86df7b51cb082d5d2d575987cd13383)]:
  - @dudousxd/nestjs-agent-core@0.7.0

## 0.4.2

### Patch Changes

- Updated dependencies [[`eb3aaff`](https://github.com/DavideCarvalho/nestjs-agent/commit/eb3aaff531cc923de1d0bccebb2b0690b4c92263), [`781a30f`](https://github.com/DavideCarvalho/nestjs-agent/commit/781a30f6579d5b9a69f341b8eeac02c273dbb8a1)]:
  - @dudousxd/nestjs-agent-core@0.6.0

## 0.4.1

### Patch Changes

- Updated dependencies [[`1c44152`](https://github.com/DavideCarvalho/nestjs-agent/commit/1c4415295a6280527e762f13e6aed48099ae5ca5), [`1c44152`](https://github.com/DavideCarvalho/nestjs-agent/commit/1c4415295a6280527e762f13e6aed48099ae5ca5)]:
  - @dudousxd/nestjs-agent-core@0.5.0

## 0.4.0

### Patch Changes

- Updated dependencies [[`abb32bc`](https://github.com/DavideCarvalho/nestjs-agent/commit/abb32bc0396c65a59ee2b92a1a8b07d772215e31)]:
  - @dudousxd/nestjs-agent-core@0.4.0

## 0.3.3

### Patch Changes

- [`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46) - Carry image/PDF attachments through a chat turn so a vision-capable model sees them natively. A new
  `MessageAttachment` (`{ mediaId, url, contentType, name }`) rides an optional `attachments` field on
  `AgentRunInput`, `AppendMessageInput`, `StoredMessage`, and `ModelMessage`: the chat controller and
  `AgentService` accept it, the loop persists it on the user message and replays it, the MikroORM store
  round-trips it as a JSON column on `agent_message` (auto-added by the additive schema heal — no
  migration), and the AI-SDK adapter renders a user message with attachments as native `image`/`file`
  content parts (`image/*` → image, else file — Bedrock Claude reads a PDF this way). The React
  transport forwards per-send attachments via the request body
  (`sendMessage({ text }, { body: { attachments } })`).

  All fields are optional, so text-only consumers are unaffected. The lib stays provider-agnostic: it
  passes the attachment `url` straight through as the part's source — making that URL reachable by the
  provider (presigned S3, a proxy) is the consumer's concern; the lib never fetches bytes or talks to a
  store.

- [`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46) - Stream structured turn events so clients render text, reasoning, and live tool-call cards — not just
  text. The sink now carries an NDJSON `AgentStreamEvent` vocabulary (`step-start`/`step-finish`,
  `text`, `reasoning`, `tool-input-start`/`-delta`/`-available`, `tool-output`/`-error`): the AI-SDK
  adapter emits model parts, the loop emits tool results, the chat controller forwards each line as an
  SSE frame, and the React transport maps them back to the AI SDK UI-message chunk protocol. Tool
  cards (input streaming → rendered output) and reasoning now appear live via `useAgentChat`, matching
  a native `streamText().toUIMessageStream()` while keeping the sink a format-agnostic byte buffer
  (durable buffering/replay untouched).

  Note: this changes the on-the-wire chat SSE protocol from `{delta}` text frames to
  `AgentStreamEvent` frames — upgrade backend (`@dudousxd/nestjs-agent`) and client
  (`@dudousxd/nestjs-agent-react`) together.

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
