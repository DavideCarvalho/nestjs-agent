---
'@dudousxd/nestjs-agent-react': minor
---

Headless attachments.

- `useAttachments({ upload | backend, accept, maxBytes, maxFiles })`: staged items with `status` (`uploading` / `ready` / `error` / `rejected`), `progress`, `error` and image `previewUrl`; `add` (from an input, a paste or a drop), `remove` (cancels the upload), `retry`, `clear`; `isUploading`; `attachments` / `refs` to send; and markup-free `inputProps`, `dropZoneProps` + `isDragging`, `onPaste`.
- `AgentClient.uploadAttachment(file, { signal, onProgress })` reports upload progress (XHR when no `fetch` was injected) and can be cancelled.
- `messageFiles(message)` — the files on a message with `kind` (`image` / `pdf` / `text` / `audio` / `video` / `other`), `extension` and, for replayed ones, the stored `mediaId`. Plus `acceptsFile`, `fileKind`, `filesFromClipboard`, `dragHasFiles`.
- Replayed attachment file parts carry `providerMetadata.agent.mediaId`.
