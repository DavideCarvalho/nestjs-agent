---
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-react": minor
---

Chat attachments on Aviary media, ready-made. `@dudousxd/nestjs-agent/media` adds
`AgentMediaAttachmentsModule.forRoot({ collection?, maxBytes?, allowedContentTypes?, visibility?, … })`
(+ `forRootAsync`): an `AGENT_ATTACHMENT_STAGING` backed by `@dudousxd/nestjs-media` (each attachment
a media record owned by the actor; resolve → presigned/public/inline url; list; owner-or-own-thread
authorization; `remove` for sweeps; opt-in `indexForRag`), plus resumable upload routes that open an
owned tus session on nestjs-media's own tus endpoint (`POST/DELETE <path>/attachments/uploads`,
`POST …/:mediaId/complete`). `@dudousxd/nestjs-agent-react/media` adds `createMediaUpload` (a
resumable `upload` for `useAttachments` with progress and abort, on `@dudousxd/nestjs-media-client`)
and `withMediaUploads(backend)` to plug it in once. Both media packages are optional peers — the root
entries and bring-your-own-storage path are unchanged.
