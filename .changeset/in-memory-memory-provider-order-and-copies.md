---
'@dudousxd/nestjs-agent-testing': patch
---

`InMemoryMemoryProvider` holds two parts of the `MemoryProvider` contract it was stating but not
keeping. Both matter more here than in any other adapter: this is the shape a host copies when it
writes its own provider, so a divergence between the reference and the SQL adapters teaches the wrong
contract.

- `search` now returns records **most-relevant-first**, as `MemoryProvider.search` requires. The
  relevance ranking was computed and then dropped, and the results came back in whatever order the
  map happened to hold them. That is not cosmetic: `resolveMemoryDigest` selects by a record's
  POSITION under `ranked` rather than by scope, so a provider returning the right set in the wrong
  order hands the prompt ceiling a relevance judgement nobody made — and silently keeps the wrong
  memories when there are more matches than `maxMemories`. Records sharing a key stay adjacent, and a
  pinned record whose key ranked nothing sorts last, because the digest lifts pinned entries ahead of
  the ceiling anyway and placing one among the ranked would cost a slot the query did ask for.
- The store and its callers no longer share objects. `write` filed the caller's `origin` by reference
  and returned the very record it had stored, and `list`/`all` handed out the live map values — so a
  consumer mutating anything it read, or mutating an input after the write returned, silently
  rewrote the store. Every value crossing the boundary is now a copy, `origin` included, which is
  what a SQL adapter gets for free by mapping rows.

The specs that pin these are the discriminating kind: an order-sensitive assertion over more than one
result, and a mutate-then-re-read for each of the four ways a caller can reach a stored object.
