---
'@dudousxd/nestjs-agent-store-drizzle': patch
'@dudousxd/nestjs-agent-store-mikro-orm': patch
'@dudousxd/nestjs-agent-testing': minor
---

Forking a thread no longer drops a message's `attachments` and `runId`.

Both SQL adapters copied a forked message field by field and omitted two of them, while the
in-memory store copied the whole object — a three-way divergence in what "fork" means. So forking a
thread silently lost its attachments, and the copied messages could no longer be attributed to the
turn that wrote them. Nothing logged; the fork just came back thinner.

The fixture that catches this is now shared rather than rewritten per spec:
`EVERY_MESSAGE_FIELD` is exported from `@dudousxd/nestjs-agent-testing`, typed
`Required<Omit<AppendMessageInput, 'threadId' | 'role' | 'content'>>`, so a new optional field on
the input fails to COMPILE until it is filled in — and then fails every adapter's round-trip test
until that adapter carries it. A consumer writing its own `AgentStore` can hold it to the same
contract.

A forked message keeps the `runId` of the turn that produced it. The copy is that same message, so
the attribution is truthful, and a run-scoped read still resolves through the run's own thread —
which is the original, never the fork.
