---
"@dudousxd/nestjs-agent-dashboard": minor
---

The console's list endpoints now speak the Aviary list wire. `GET runs`, `tool-calls`, `threads` and `approvals` are offset lists: `page` (1-based), `size` (default 25, clamped to 200), `filter[field]=value` (the fields the old `where[...]` accepted; the thread title search is `filter[title][contains]`) and a `sort` that accepts only the list's fixed order (`-startedAt`, `-createdAt`, `-lastActivityAt`, `requestedAt`). They answer `{ data, meta: { total, perPage, currentPage, lastPage, firstPage } }`; an unknown filter field, an unsupported operator, a malformed `page`/`size` or another sort is a 400.

Breaking for direct HTTP callers: the `*-page` twins (`runs-page`, `tool-calls-page`, `threads-page`, `approvals-page`) and the bare-array `?limit=` forms are gone, with no aliases. `GET top-threads` takes `size` instead of `limit` and answers `{ data }`. `GET threads/:id` keeps its `messages`/`runs` caps.

The `/client` export follows: `runs`, `toolCalls`, `threads` and `approvals` take `{ page?, size?, filter? }` and resolve to `{ data, meta }`; `runsPage`/`toolCallsPage`/`threadsPage`/`approvalsPage` are removed; `GovernancePage`/`GovernancePageQuery` give way to `OffsetPage`/`ListQuery`, and the `*Where` filter types are now `*Filter`. `topThreads(range, size)` resolves to `{ data }`. The MCP dev tools keep their `{ items, next }` output.
