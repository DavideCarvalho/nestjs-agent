---
'@dudousxd/nestjs-agent-codegen': minor
---

The injected agent routes follow the agent's new list wire (`@dudousxd/nestjs-agent` 4.0). `agents`, `threads`, `skills`, `tools`, `memories` and `attachments` `.list` respond `{ data }`, and `models.list` responds `{ data, default, locked? }`. Filters are flat `filter[...]` query keys (`{ 'filter[agent]': 'support' }`), and `threads` / `attachments` take `size`. `actionProposals.list` takes `after` / `first` and responds with one cursor page, `{ data, meta: { nextCursor, prevCursor, hasNext, hasPrev } }`.
