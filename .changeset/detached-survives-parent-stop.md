---
'@dudousxd/nestjs-agent': patch
'@dudousxd/nestjs-agent-core': patch
---

A detached delegation now survives a Stop on the turn that started it (durable runner). It used
to be a `ctx.startChild` child, and the runtime cascades a parent's cancel to every run it spawned —
so stopping the visible turn after it had handed work off also cancelled the background run, which
died parked where its body never runs again and left the delegating card "started" for ever. It is
now started as a run of its own from a journaled `detach:<toolCallId>` step (behind
`ctx.patched('agent:detached-unlinked')`, stamped with the parent's namespace, under a deterministic
id); the child's input still carries `parentRunId`. A run that journaled its `spawn:` before this
release replays it unchanged.

Stopping a detached run by its own id while it is parked on a human now settles its card
`cancelled` and posts the "stopped" message — the runner does it, since a parked body never runs
its own settle. The same happens for a detached child a pre-upgrade parent's Stop still cascades to.
`settleUnsettledDelegation` settles once: a thread already holding a message from the run is left
alone.
