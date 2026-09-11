---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
'@dudousxd/nestjs-agent-react': minor
---

Start a sub-agent and keep talking.

A delegation was synchronous: an `agent`-kind tool mapped to a child run the parent **awaited**, so
the conversation was held open for as long as the specialist took. For a specialist that takes
minutes, that is the wrong shape — the user sits watching a spinner for work they never needed to
watch.

An edge can now be declared detached, and then it isn't:

```ts
@Agent({
  name: 'ops-orchestrator',
  handoff: [
    WeatherAnalystAgent,                           // awaited  -> ask_weather_analyst
    { agent: DeepResearchAgent, detached: true },  // detached -> start_deep_research
  ],
})
```

The turn ends with a **receipt** (`{ detached: true, status: 'started', agent, runId, note }`) as the
call's result instead of an answer, and the started run posts its answer into the same thread later,
as its own message stamped with its own `runId` and `agentName` — so a client renders "the research
agent finished" rather than the assistant's next reply. The `note` says the same thing in prose,
because a tool result is the only vocabulary a model reliably acts on, and a model handed something
shaped like a result will report one.

**The author declares it, per edge — the model does not.** A model that can decide to detach can
decide to detach the one thing the user is sitting there waiting for, and it has no way to know which
that is. The same specialist can be both: `ask_<name>` and `start_<name>` are separate tools.

**Determinism.** Whether a call detaches is settled inside its `persist:toolcall` checkpoint, beside
the kind and target that already live there, and read back from the journal on every replay — never
from a registry lookup in whichever process happens to be replaying. Flipping an edge therefore
changes what new runs do and nothing about a run already in flight. The loop writes the SAME
checkpoint names for both branches; only the runner's own positions differ (`ctx.startChild`'s
`spawn:<id>` instead of the awaited child's suspend-and-join). A deployment that declares no detached
edge writes byte-identical checkpoints, payloads included, and needs no patch marker.

**Streaming and approvals.** A detached run owns its own sink and its `action` tools park on its own
run, so its tokens and its approval card never land in a stream whose reader has already seen `done`,
nor in whatever unrelated turn happens to be open next. Its approval goes to the pending-approvals
inbox, which it reaches for free — the call is persisted `pending_approval` against the child's own
`runId`, and that is what `runForToolCall` answers with. The run is subscribable on its own id.

**Lifecycle.** It parks on an approval nobody gives, with no library-owned timeout — a deadline on a
human decision is the host's policy — and stays visible and cancellable meanwhile. Cancelling the
turn that started it takes it with it (the durable runtime cascades to children). Delivery is skipped
when the thread was deleted. A run that dies or is stopped posts a message saying so and settles its
delegation's row, because `started` is the one state a reader can neither wait on nor act on.

**Observability.** Both the awaited and the detached child now record `parentRunId` on
`AgentStore.recordRunStart` (optional on the SPI; a store that persists nothing for it loses the
tree, not the run), so a delegation's cost can be rolled up to the turn that asked for it. The
`aviary:agent:delegated` event carries `detached`.

**The client.** `useAgentChat({ background: true })` exposes `background.runs` / `background.isWorking`
/ `background.refresh()`, and appends a delegate's answer to `messages` when it lands — no reload.
Both halves come from one thread read, so a reload or a second tab sees what the tab that started it
sees; the interval (`backgroundPollMs`, default 5000) exists only while something is outstanding.
`storedThreadToUiMessages` also stops merging consecutive assistant rows from **different runs**,
which it had to: a detached answer merged into the previous turn reads as the assistant having said
both.

**Breaking.** `delegateToolName(target)` now takes `delegateToolName({ target, detached })` — a
detached edge needs its own name, since one agent can be both awaited and backgrounded by the same
orchestrator and one tool name cannot carry both. `AgentDefinition.delegatesTo` is now
`AgentDelegation[]` (`string | { agent, detached? }`); a bare name still means exactly what it did.
