---
'@dudousxd/nestjs-agent-core': minor
---

Journal the messages a turn sends, not the thread the store returned.

`load:thread` checkpointed the whole `ThreadDetail` — every message row, its id and timestamp, and
every tool output the thread ever recorded. `hooks.step` checkpoints its OUTPUT, so that object was
written to a JSON column, re-read by the engine on every workflow execution of the run, and
re-parsed by every process that resumed it. Measured on a 20-turn thread with 8 KB tool outputs:
**176 KB of a 185 KB journal, 95% of everything the turn wrote down** — and a configured
`historyPolicy` did nothing about it, because selection ran after the checkpoint. The ceiling the
model's prompt respected was not a ceiling on the journal.

`HistoryPolicy.select` now runs **inside** `load:thread`, and the checkpoint holds the selection:
the messages the turn will send, the title, whether the thread already had an assistant message,
and — only where a summarizer is configured to fold them in — the messages the ceiling dropped. On
the same thread with `history: { maxMessages: 10 }`, `load:thread` goes from 175,829 to 42,925
bytes and the whole journal from 184,818 to 51,914 (a 4-tool turn: 209,742 → 76,838). With no
policy configured the payload still sheds the store's own bookkeeping: 15,989 → 12,424 bytes on a
20-turn thread of small tool outputs.

`select` is still contractually pure and still costs no checkpoint position of its own. What it
costs is the payload, which is why the change is guarded.

**Replay.** `load:thread` keeps its name and its position, but a checkpoint's payload is a wire
contract with every run in flight just as its name is: a run recorded under the old shape carries no
record of the split, so a resume that read it as the new shape would skip the `history:summarize`
position its history has already spent. The loop therefore asks `ctx.patched('agent:selected-history')`
and keeps the whole-thread load for a run that answers `false` — the marker is position-transparent
for such a run, so it replays exactly the sequence it recorded. A runner that wires no `patched`
hook (an inline one, which records nothing) takes the new shape and spends no position at all.

A marker rather than tolerating both payload shapes, because the two cannot be told apart where it
matters: both carry `messages` and a `title`, and an empty thread serializes to something either
release could have written. The marker is a fact the journal holds, at a position the runtime hands
back; the bytes are a guess.

This does not fix the underlying read. `AgentStore.getThread` still returns the entire transcript,
unprojected and unlimited — the loop just stops writing it down again.

`AgentLoopHooks.patched` is unchanged and still optional.
