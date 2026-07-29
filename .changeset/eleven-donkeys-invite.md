---
'@dudousxd/nestjs-agent-rag-media': minor
---

rag-media: make an ingestion failure branchable, so a host can tell "retry this" from "this will never work"

`MediaIngestOutcome`'s failure arm was `{ status: 'failed'; error: string }` — the original error was stringified by `runMediaIngestJob`'s catch-all and thrown away. A host driving ingestion from a durable workflow could only re-throw blindly, so a permanently corrupt PDF was retried to exhaustion exactly like a transient S3 blip.

The failed outcome now carries two more fields:

```ts
{ status: 'failed'; error: string; kind: MediaIngestFailureKind; cause?: unknown }
```

- **`kind`** — which phase threw: `'read' | 'extract' | 'embed' | 'store' | 'unknown'`. `read` is the `statFile` probe and the `readFile` fetch; `extract` is `TextExtractor.extract` plus the chunking that follows it; `embed` is the `EmbeddingProvider`; `store` is the `VectorStore` (the pre-ingest `remove`, the final `upsert`, and delete-sync). Required, not optional — a consumer branching on a return type should not have to handle a fourth `undefined` case.
- **`cause`** — the original thrown value, with its class and its own `cause` intact, so a host can apply its own retry policy (`cause instanceof ThrottlingException`) instead of parsing a message. **In-process only:** it rides the return value and the `aviary:rag:media.failed` publish by reference, and is deliberately absent from the persisted payload, because an `Error` JSON-stringifies to `{}`.

Deliberately NOT a `retryable` boolean. Retryability depends on the underlying error *and* host policy, not on the phase — a `read` failure is transient for an S3 5xx and permanent for a 404 — and every one of these deps is host-injected, so a library-emitted boolean would be a guess, with a wrong `retryable: false` silently dropping a document.

Also additive:

- `mediaIngestFailureKind(error)` — read the phase off a caught error, for callers that use `ingestMediaFile` / `applyMediaIngestJob` directly. Returns `'unknown'` for anything untagged, so it is total.
- `RagMediaFailedPayload.kind?` — the phase on the `aviary:rag:media.failed` diagnostic, as a plain string that survives cloning and persistence. Optional here because the enqueue-failure path publishes when no phase ever ran.

Nothing is wrapped or replaced: the phase is stamped onto the original error as a non-enumerable, globally-registered symbol (`Symbol.for('aviary.rag.media.ingestFailureKind')`) and the same object is re-thrown, so an existing `catch (e) { e instanceof S3Error }` keeps working and the tag cannot leak into a JSON log. `error` is unchanged, and the `unsupported-type` skip path is untouched.
