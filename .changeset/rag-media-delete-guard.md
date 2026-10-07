---
"@dudousxd/nestjs-agent-rag-media": patch
---

`isMediaDeleteEvent` now also requires a non-empty `ownerType` and `ownerId`, which `MediaDeleteEvent` and `RagMediaRemovedPayload` both declare. Before, a payload with only an `id` passed the guard, and `undefined` owner fields reached the `rag-media.removed` event.
