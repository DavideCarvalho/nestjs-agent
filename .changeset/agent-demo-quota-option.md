---
"agent-demo": patch
---

The demo now passes `quota: { limits: { day: { tokens: 200_000 } } }`. It used to pass an `InMemoryQuotaStore`, which is not a valid `quota` option. The demo script also reads `GET /agent/quota` instead of the removed `/agent/quota/today`. The example now has a `typecheck` script, so this kind of drift fails `pnpm typecheck`.
