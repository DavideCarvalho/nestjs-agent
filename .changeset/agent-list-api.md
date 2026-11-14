---
'@dudousxd/nestjs-agent': major
---

The agent's product REST list endpoints move to the Aviary list wire. Every list answers an object with its rows in `data`, never a bare array. Filters are `filter[field]=value`. A query param a route does not read now answers `400`, naming its replacement, instead of being ignored.

Breaking wire changes (before → after):

- `GET <base>/threads/:threadId/action-proposals`: `?after=<URI-encoded JSON { createdAt, id }>`, up to 1000 rows as `ActionProposalView[]`, next cursor in the `X-Action-Proposals-Next` response header → `?after=<opaque cursor>&first=<n>` (default 100, at most 1000), `{ data: ActionProposalView[], meta: { nextCursor, prevCursor, hasNext, hasPrev } }`. The header (and its `Access-Control-Expose-Headers` entry) is gone. The old JSON cursor, or any malformed one, answers `400`. Paging is forward only: `before` / `last` answer `400`.
- `GET <base>/attachments`: `StagedAttachment[]`, always 50 → `{ data: StagedAttachment[] }`, sized by `?size=` (default 50, at most 200).
- `GET <base>/threads`: `ThreadSummary[]` (the store's default 50) → `{ data: ThreadSummary[] }`, sized by `?size=` (default 50, at most 200).
- `GET <base>/memories?threadId=` → `GET <base>/memories?filter[threadId]=`, `MemoryDigestEntry[]` → `{ data: MemoryDigestEntry[] }`.
- `GET <base>/skills?threadId=` → `GET <base>/skills?filter[threadId]=`, `SkillCatalogEntry[]` → `{ data: SkillCatalogEntry[] }`.
- `GET <base>/tools?agent=` → `GET <base>/tools?filter[agent]=` (`filter[agent]=*` for every agent), `ToolCatalogEntry[]` → `{ data: ToolCatalogEntry[] }`.
- `GET <base>/models?agent=&persona=` → `GET <base>/models?filter[agent]=&filter[persona]=`, `{ providers, default, locked? }` → `{ data: providers, default, locked? }`.
- `GET <base>/agents`: `AgentCatalogEntry[]` → `{ data: AgentCatalogEntry[] }`. It takes no query params.
- On all of these, an unknown param answers `400`, for example `?agent=x` ("use `filter[agent]`") or `?limit=5` ("use `size`" or "use `first`").

Attachments and threads are sized lists, not paged ones, because their store SPIs take only a cap: `AttachmentStagingStore.list` has no keyset tiebreak and `AgentStore.listThreads` has no offset or count.

`AgentService.listThreads(actor, { limit? })` and `ActionProposalService.listPage(threadId, actor, { after?, limit? })` gain an optional size. New exports: `ACTION_PROPOSAL_PAGE_SIZE`, `ACTION_PROPOSAL_MAX_PAGE_SIZE`, `encodeActionProposalCursor`, `decodeActionProposalCursor`, `ATTACHMENT_MAX_PAGE_SIZE`, `THREAD_LIST_SIZE`, `THREAD_LIST_MAX_SIZE` and the `ModelCatalogListResponse` type.

Migration: upgrade `@dudousxd/nestjs-agent-react` and `@dudousxd/nestjs-agent-codegen` along with the server; `AgentClient` keeps its method signatures and unwraps the new answers. A hand-written client reads `body.data` instead of the body, sends `filter[...]` instead of the flat params, and follows `meta.nextCursor` (passed back as `after`) instead of the `X-Action-Proposals-Next` header. Drop that header from your CORS expose list.
