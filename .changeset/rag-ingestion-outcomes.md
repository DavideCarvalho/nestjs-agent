---
'@dudousxd/nestjs-agent-rag-media': minor
---

Make ingestion outcomes observable from outside the package.

`skipped` and `failed` diagnostics now carry the owner/collection coordinates the `ingested` payload
already had (via the new `RagMediaOutcomeContext` and the `outcomeContext(event)` helper), so a
subscriber can attribute an outcome to the collection it belongs to instead of a bare media id.

New `runMediaIngestJob(job, deps)`: `applyMediaIngestJob` with the error boundary attached. It never
throws and returns a `MediaIngestOutcome` covering all four terminal states (`ingested`, `skipped`,
`removed`, `failed`), publishing `aviary:rag:media.failed` on the way out. Previously that boundary
lived inside `AgentMediaIngestionService`'s private `dispatch()`, so anything calling
`ingestMediaFile` directly — a diagnostics-channel subscriber, a queue consumer, a fire-and-forget
upload hook — got no failure signal beyond an unhandled rejection. The service now routes through the
same function, so the inline and direct paths cannot drift.
