---
'@dudousxd/nestjs-agent-testing': minor
---

Ship a `MemoryProvider` you can actually run: `InMemoryMemoryProvider`, plus the fixtures an adapter
is held to.

Memory has shipped an SPI, a `remember` tool and a `memory:digest` checkpoint, and no storage — so
every deployment that wanted the feature wrote a provider first, including the specs. There was no
implementation of the interface anywhere in this repository, which meant the rules the SPI's own
documentation states were prose rather than something executable.

`InMemoryMemoryProvider` is the whole interface:

- `list` returns only records at the scopes it was given. The gate is in the LOOKUP, not after it:
  the library drops out-of-scope records it is handed, but that is a backstop, and an adapter that
  leans on it has made privacy a property of its caller.
- `write` upserts on (`scope`, `key`) and carries `pinned` across the rewrite. An upsert that reset
  the flag would silently unpin a record the next time the agent restated the same key.
- `write` refuses an agent-authored record at any scope but the actor's own — the storage half of
  `memoryWriteVerdict`'s third rule. A human-authored one at a wider scope is allowed, because that
  is what a host console publishing an organisation's policy does, and whether that person may write
  there is a question `memoryWriteVerdict` answers with facts a provider is not handed.
- `forget` deletes only from the actor's own scope, so an id alone cannot reach a tenant's or the
  deployment's memory. A missing id and somebody else's id answer identically.
- `pin({ id, pinned })` is the operator act the SPI has no method for, on purpose: a pin grants a
  fact a permanent place in every future prompt, so nothing an agent can reach may set it.

`{ recall: true }` also serves `search`, ranked by word overlap. Word overlap is not a relevance
model; it is deterministic, and it exercises the path a host with an index takes — including the
clause that is easy to miss, where every record sharing a ranked key has to travel or the block
renders an organisation's value as the actor's own. Without the option there is no `search` property
at all, which is the switch `offerMemories` reads.

`everyMemoryField(ctx)` and `expectedMemoryRecord(...)` are the round-trip fixtures, typed
`Required<StoreMemoryInput>` and `Required<MemoryRecord>` the way `EVERY_MESSAGE_FIELD` and
`everyRunStartField` are. A field added to either shape fails to **compile** in the fixture until it
is filled in, which is earlier than any assertion — an origin field an adapter silently drops is
invisible to a test that asserts only on the fields someone remembered.
