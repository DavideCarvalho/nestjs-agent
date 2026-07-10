# Multimodal attachments in nestjs-agent

**Goal:** Let a chat turn carry image + PDF attachments so a vision-capable model
(Bedrock Claude) sees them natively. flip's admin-ai is the first consumer; it
uploads through its existing `@dudousxd/nestjs-media` pipeline and passes the
resulting media ref as an attachment on the turn.

**Decision (Davi, 2026-07-10):** lib-deep multimodal (real vision, not a
tool-read hack), image + PDF in the first cut.

## Data path

```
flip ChatInput ──upload via nestjs-media──▶ {mediaId,url,contentType,name}
   │ POST /chat { message, attachments }
   ▼
chat.controller ChatBody.attachments
   ▼
AgentService.chat → AgentRunInput.attachments
   ▼
agent-loop: appendMessage({ role:'user', content, attachments })   (persist:user)
   ▼  reload + map (agent-loop.ts:282)
StoredMessage.attachments → ModelMessage.attachments
   ▼
ai-sdk mapMessages: user message → content array [ text, image|file parts ]
   ▼
Bedrock Claude sees the image/PDF natively
```

## The shape

```ts
// @dudousxd/nestjs-agent-core
export interface MessageAttachment {
  /** Stable id of the stored media object (consumer's media store). Replay/provenance key. */
  mediaId: string;
  /** A URL the model provider can fetch the bytes from at turn time (flip: its media proxy/presigned S3). */
  url: string;
  /** MIME type — routes the part: image/* → image part, else → file part. */
  contentType: string;
  /** Original filename, for display + the file part filename. */
  name: string;
}
```

Added as an optional `attachments?: MessageAttachment[]` on: `AgentRunInput`,
`AppendMessageInput`, `StoredMessage`, `ModelMessage`. Optional everywhere, so a
text-only consumer is untouched.

## Per-package changes

- **core** — the `MessageAttachment` type + the four optional fields; thread
  `attachments` in `agent-loop` (append + StoredMessage→ModelMessage map).
- **store-mikro-orm** — `attachments` JSON column on `AgentMessage` (immutable
  metadata read only with its message → JSON column, not a new entity/table);
  persist in `appendMessage`, hydrate in `getThread`/`toStoredMessage` and the
  model-message mapping.
- **ai-sdk** — `mapMessages` user branch builds a content array with native
  `image`/`file` parts when the message has attachments (the adapter already
  builds content arrays for tool calls — same extension point).
- **nestjs** — `ChatBody.attachments` + `ChatParams.attachments` +
  `AgentRunInput.attachments` wiring (both inline and durable runners consume
  `AgentRunInput`, so both get it; attachments are plain JSON → replay-safe).
- **react** — `useAgentChat` send path carries attachments; expose on messages.
- **flip** (consumer, not lib) — `ChatInput` attach button + upload bridge to the
  existing media flow; `MessageItem` thumbnail/chip rendering.

## Boundaries

- The lib stays provider-agnostic: it passes the attachment `url` through as the
  AI SDK image/file part data. Making that URL reachable by the model provider is
  the consumer's job — flip already solved this with its media proxy. The lib
  never fetches bytes or talks to S3.
- JSON column over a normalized `agent_attachment` table: attachments are small,
  immutable, and only ever read alongside their message; no independent query
  need, so no join/entity/migration churn is justified.

## Known limitation — presigned-URL staleness under durable replay

The persisted `url` is whatever the consumer stored (flip: a presigned S3 GET
with a finite TTL). An **inline** run consumes it immediately, so it is always
fresh. A **durable** run that suspends and replays past the TTL would re-run the
model turn against an expired URL and fail to fetch the bytes. flip is on the
inline runner today, so this is latent. When durable is re-enabled for the agent,
the consumer should store a stable media key and re-resolve a fresh URL at
turn-time (e.g. a flip attachment-resolution step) instead of baking a
short-lived URL into the message.

## Release

Changesets on core, store-mikro-orm, ai-sdk, nestjs, react (minor — additive,
all fields optional). flip picks up the new versions + adds the composer UI.
