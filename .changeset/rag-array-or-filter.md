---
'@dudousxd/nestjs-agent-rag': minor
---

Metadata filters now accept **array values** as a **match-any** (OR / set-membership) predicate, in
addition to the existing scalar exact-match. A record matches an array-valued filter key when its
metadata value for that key is one of the array's elements — or, for a multi-valued record, shares
at least one element with it. An empty array matches nothing (the deny primitive). Scalar filter
values are unchanged, so this is backward compatible.

This is the capability-token access-control primitive: give each document an opaque `audience` tag
(e.g. `['public']`, `['role:ADMIN']`, `['base:…']`) and pass the caller's token set as the filter
(`{ audience: ['public', 'role:ADMIN', 'base:…'] }`) — the store returns only documents the caller
is entitled to, without ever knowing what a token means.

Implemented across all three stores:

- `MemoryVectorStore` / `KeywordRetriever` (`matchesFilter`) — membership/overlap.
- `RedisVectorStore` — TAG alternation (`@meta_audience:{public|role\:ADMIN}`); array metadata is
  stored as a multi-valued TAG so a document can carry several tokens. Empty-array filters
  short-circuit to an empty result (RediSearch has no empty-tag syntax).
- `PgVectorStore` — jsonb `?|` over the (array-normalized) metadata value; metadata keys are passed
  as query parameters so a caller-supplied key can't inject SQL.
