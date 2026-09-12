---
'@dudousxd/nestjs-agent-codegen': minor
---

Six JSON routes the library serves were missing from the generated client, so every host using
codegen had no typed way to call them: `GET /agent/skills`, `GET /agent/memories`, `DELETE
/agent/memories/:id`, `POST /agent/tool-call/answer`, `POST /agent/tool-call/skip` and `GET
/agent/attachments`. Their siblings were all there, which is what made the gap invisible — a
frontend reaching for `api.agent.skills.list()` found nothing and had no reason to suspect the
endpoint existed.

The list is hand-written against controllers this package deliberately does not import, so it can
only drift. `covers-every-json-route.spec.ts` now reads those controllers off disk and fails when a
route is in neither the injected list nor an explicit not-modelled list. Three routes are on that
list, each for a reason codegen cannot express: the two SSE chat endpoints, and the multipart
`POST /agent/attachments`.
