---
'@dudousxd/nestjs-agent-react': patch
---

Stopping an answer no longer leaves an unhandled `AbortError` in the console. The chat's stop aborts the request, which errors the response body; the transport then cancelled that body and dropped the promise, which rejects with the same `AbortError: BodyStreamBuffer was aborted`.
