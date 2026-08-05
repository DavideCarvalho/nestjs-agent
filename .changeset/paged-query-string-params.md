---
'@dudousxd/nestjs-agent-telescope': patch
---

Fix paging on the Agent tab's list tables: `Next` did nothing, then stopped responding entirely.

`resolvePage` and `resolveLimit` read their value behind a `typeof raw === 'number'` guard. That
rejects every value a real request can carry: the dashboard serializes a panel's query into the URL
and the host controller passes `@Query()` through verbatim, so `?page=2&limit=20` reaches the
provider as the **strings** `'2'` and `'20'`. Both fell through to the default, so every request
returned page 1 — verified against a deployment: `?page=2&limit=5` answered with `page: 1`,
`limit: 50` and the same 50 rows as `?page=1`.

The visible failure was worse than a stuck first page. The pager renders the page the *response*
reports, so `Next` appeared to do nothing; and because the control then keeps computing `page + 1`
from that pinned `1`, the second click requests the page the UI is already on, React skips the
re-render, and the pager stops responding at all — `Prev` never re-enables either, short of a reload.

Both helpers now accept a numeric string as well as a number, and reject anything that is not a
positive number (`''`, `'banana'`, `'0'`, `'-2'`, `'NaN'`) rather than letting it reach the
read-model as a `NaN` offset. The existing specs passed real numbers throughout, which is why the
guard survived; the new ones use the string form the wire actually delivers.
