---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
---

Stop taking attachment URLs, live-stream access and human replies from the request body.

Four fixes from a security review of the HTTP surface. The first two are **breaking** — deliberately,
because the compatible version of either is "keep trusting the client".

**1. `POST /agent/chat` no longer accepts a url (SSRF).** `attachments` was typed
`MessageAttachment[]` and passed through verbatim, so the caller chose the url the model provider
fetches at turn time. Any authenticated user of an app on this library could make the server fetch
`http://169.254.169.254/latest/meta-data/iam/security-credentials/` — or any internal address it can
reach — and read the response back out of the model's answer. It also bypassed the upload route's
content-type allowlist and size cap, being a different route.

A chat turn may now only name a `mediaId`; every other field sent with it is discarded.
`AttachmentStagingStore` gains **`resolve({ mediaId, actor })`**, which returns the
`MessageAttachment` to send or `null` when the id is unknown *or* is not that actor's (the two are
indistinguishable on purpose, so the endpoint can't be used to probe media ids). The url the model
fetches now only ever comes from the host's own store, and is resolved per turn — which also fixes
the stale-presigned-url problem a durable run that replayed past a url's TTL used to have.

*You are exposed if* your app sends `attachments` on a chat turn. *To upgrade:* implement `resolve`
on your `AttachmentStagingStore` (TypeScript will tell you — it is a required method) and make sure
it checks ownership; it is the ONLY thing standing between a caller and an arbitrary server-side
fetch. Clients need no change as long as each attachment carries its `mediaId` — which the object
returned by `POST /agent/attachments` and `AgentClient.uploadAttachment` already does. **With no
`AGENT_ATTACHMENT_STAGING` bound there is no way to tell an actor's own media from anyone else's, so
a turn carrying attachments is refused with `501` rather than trusted.** A text-only turn is
unaffected. A turn may name at most 10 attachments.

**2. `GET /agent/chat/:runId/stream` is ownership-scoped.** It resolved no actor and checked
nothing: anyone past the module's own guards holding a `runId` read another actor's live turn — the
answer, tool arguments, tool results, and the RAG passages and structured output that ride as
synthetic tool calls. A `runId` is a UUID, but it is handed out in the `X-Agent-Run-Id` header, the
SSE `meta` frame, Telescope, the durable dashboard and the logs. It now resolves the actor and
checks the run the way `POST /agent/chat/:runId/cancel` already did: `403` for another actor's run,
`404` for a run nobody is streaming. **A run that has already finished is now a `404` instead of a
buffer replay** — ownership is derived from the thread's active stream, which the runner clears as
the run ends. `AgentService.subscribeAs(actor, runId)` is the gated call; `subscribe(runId)` stays
ungated for in-process callers that are authorized upstream, the same split
`approve` / `signalToolCall` already uses.

**3. `POST /agent/tool-call/*` validates its body.** `answers` was typed `Record<string, string[]>`
and checked nowhere, so `{"answers":{"q1":"oops"}}` reached the elicitation resolver and threw on
`.filter` of a string. The signal payload is journaled, so *every replay reproduced the crash* — one
malformed request killed a run permanently and burned its durable retries. Shape and size are now
checked before anything is signalled (at most 100 questions, 100 values each, 4096 characters per
value), as is `reject`'s `reason` (a string, at most 4096 characters — it reaches the model as a
tool result) and every route's `toolCallId`. Well-formed requests, including an empty `answers`,
behave exactly as before.

**4. `POST /agent/attachments` bounds the upload before buffering it.** `FileInterceptor` ran with
no `limits`, so the entire body was read into memory and only then measured against
`attachments.maxBytes` — one request could OOM the pod. Multer now aborts mid-stream at
`HARD_MAX_ATTACHMENT_BYTES` (32 MiB), with the configured cap still applying as the second
gate. `attachments.maxBytes` narrows that ceiling and cannot raise it: a host that set it above 32
MiB now gets `413` at the ceiling.
