---
'@dudousxd/nestjs-agent-telescope': patch
---

Stop linking every `Run` cell at a trace that cannot exist.

The `runId` column defaulted to `'#/traces/{runId}'`, and that default could only 404. Telescope's
trace waterfall is keyed by **`traceId`** — its `LinkSpec` doc says so in as many words, and
`TracesService.getWaterfall` resolves it with `storage.get({ traceId })` — while an agent's `runId`
is a different identifier that `AgentTelescopeWatcher` never ties to one: it records `type: 'agent'`
entries and stamps no trace at all.

So clicking any Run cell on the shipped dashboard answered:

```json
{ "statusCode": 404, "path": "/telescope/api/traces/<runId>/waterfall",
  "message": "No entries for trace <runId>.", "errorCode": "NOT_FOUND" }
```

`runHref` is now opt-in, exactly like `threadHref` beside it: a host that has a run viewer passes
its own template, and one that does not gets plain text. Reading the route contract correctly and
substituting the wrong key into it is the whole bug, so the default is gone rather than repointed.
