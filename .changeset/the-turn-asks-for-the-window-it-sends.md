---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent-store-drizzle': minor
'@dudousxd/nestjs-agent-store-mikro-orm': minor
---

The loop asks for the window, instead of taking the transcript.

Both SQL stores could already hand a turn the messages it was about to send. Nothing asked them to:
`runAgentLoop` loaded every thread with `getThread`, which materializes the whole transcript — every
message row, every attachment, every tool output the thread ever recorded — to build a prompt bounded
to its last few messages. Measured on a 50-turn thread whose turns each ran a 50 KB tool: **2.6 MB per
load, 99% of it tool output**, paid on every turn and again on every replay. The same thread read
through a four-message window is 103 KB.

`ThreadTurnReader` is now a core SPI seam, and `load:thread` probes the store for it:

```ts
interface ThreadTurnReader {
  loadThreadForTurn(query: { threadId: string; messageLimit?: number }): Promise<ThreadTurnPage | null>;
}
```

Probed STRUCTURALLY, not declared on `AgentStore`, the same seam `defaultAgentForThread` uses. A store
that does not implement it keeps working through the full read — no config change, no deprecation
warning, nothing to do. Both SQL adapters now implement the core interface rather than re-declaring
its shape, so the adapter and the seam the loop probes for cannot drift apart.

**Which row bound the store is given.** `HistoryPolicy` gains an optional `maxMessages`: the most
messages `select` can ever keep. Declaring it is a promise about `select` — that it keeps at most that
many, and that they are the NEWEST ones — so a window that size is indistinguishable to it from the
full transcript. `windowHistory({ maxMessages })` declares it; two cases deliberately do not, and read
everything:

- **A policy that summarizes.** `summarize` is handed what `select` DROPPED, and a read bounded to what
  `select` keeps drops nothing. The turn would fold an empty summary into a prompt that is missing the
  messages it stands in for, with no error anywhere.
- **A ceiling expressed only in tokens.** No row count follows from a token budget — one message can be
  four tokens or forty thousand. Naming one too low reads fewer rows than `select` would have kept,
  which changes the prompt; leaving it out only costs the read. A policy that wants its bound to reach
  the database states `maxMessages` alongside `maxTokens`.

**Determinism.** This changes how the data is FETCHED, not what is journaled. `load:thread` keeps its
name, its position and its payload: both reads produce the same messages, the same title and the same
`hasAssistantMessage`, so the recorded string is byte-identical and a resume reads it back without
calling the store at all. No new checkpoint, and no patch marker — `agent:selected-history` is
untouched, and the pre-marker `loadWholeThread` path still calls `getThread` exactly as it did. A spec
pins both halves: the two read paths agree byte for byte, and the payload's KEYS are named, so a field
added to what the checkpoint records fails rather than silently stranding runs in flight.

`hasAssistantMessage` comes from the page's own whole-thread flag, never from its messages. It decides
a `thread-start` intake, and a window that happens to hold only the user's last questions belongs to a
conversation that has still been answered — derived from the page, such a thread re-introduces itself
every turn.

**Upgrading.** Nothing to run, and nothing to configure. A deployment on a store without the method
behaves exactly as before; one on either SQL adapter gets the bounded read on its next turn. Runs
already in flight replay against the payload their journal holds, unchanged.
