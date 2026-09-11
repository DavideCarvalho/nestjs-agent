---
'@dudousxd/nestjs-agent': minor
'@dudousxd/nestjs-agent-store-drizzle': minor
'@dudousxd/nestjs-agent-store-mikro-orm': minor
'@dudousxd/nestjs-agent-testing': minor
---

Read a thread's default agent without reading the thread.

Every `chat()` call that does not name an agent asked the store for the thread's `defaultAgent`, and
asked for it with `getThread` — which returns the entire transcript: every message, every persisted
tool output. On a 20-turn thread with 8 KB tool results that is **173 KB read per turn, outside the
workflow, discarded immediately** for one nullable string.

Each store gains `defaultAgentForThread(threadId)`, a one-column read on the primary key, and
`AgentService` prefers it. On the same 20-turn thread the read goes from two statements returning 41
rows (173,054 bytes) to one statement returning one column (29 bytes).

The method is probed structurally against the exported `ThreadDefaultAgentReader` shape rather than
added to the `AgentStore` SPI: it is an optimization a store either offers or does not, and a store
that predates it still answers correctly through the full `getThread` read.
