---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent-testing': minor
'@dudousxd/nestjs-agent-store-drizzle': minor
'@dudousxd/nestjs-agent-store-mikro-orm': minor
---

Make a finished turn read back as a finished turn.

A standalone client built against the published surface found two things the unit tests could not,
because both only appear once something reads a thread BACK.

**A turn's tool results were never persisted onto its message.** The loop appended the assistant
message at `persist:assistant:<i>` — before the tools ran — and then attached the results to an
in-memory object nothing ever wrote. The outputs did reach the `agent_tool_call` table, and the
MikroORM adapter hid the consequence by rebuilding `toolResults` from those rows on read; Drizzle and
the in-memory store return the column as written. So on those two, every tool on a reopened thread
sat at `state: 'input-available'` forever — a UI renders that as "Running", under an answer that had
already quoted the tool's output.

The fix is one write, not three reads. `AgentStore` gains a **required** `setMessageToolResults`, the
loop calls it once with the turn's complete result list, and all three adapters return the same
column. Making it optional would have reproduced the defect for any store that declined it, silently;
a missing method should fail to compile. MikroORM now returns the message's own results and consults
the tool-call rows only for a message that carries calls and none of its own, so what it returns for
anything the loop writes is byte-for-byte what the other two return, rather than a second derivation
that happens to agree.

**Inject-mode retrieval and structured output never reached a client at all.** Both were recorded
with `recordToolCall` — the tool-call table only. Neither was added to the message's `toolCalls`, and
neither emitted a stream frame, so the passages behind a grounded answer were invisible to every
client and a validated `outputSchema` value was unreachable except by reading the store directly.
Both now ride the whole delivery path an ordinary tool call has: the assistant message's
`toolCalls`/`toolResults`, the `agent_tool_call` row, and a live `tool-input-available` +
`tool-output` frame pair. No new frame kind and no new message field — a client that renders tool
calls renders both with no change, and `@dudousxd/nestjs-agent-react` folds the retrieval into its
provenance block on the shape of its output rather than the tool's name.

Docs claiming these already worked (`guides/rag.mdx`: "the same surface, so citations render
identically"; `guides/structured-output.mdx`) are now true rather than aspirational.

**No checkpoint moved.** Every value involved is settled by a checkpoint the turn already took, so
the results write lives inside `stream:tool-outputs:<i>` and the two synthetic calls keep their
existing `persist:retrieval:<messageId>` / `persist:structured:<messageId>` positions. A turn that
configures nothing new records a byte-identical sequence, so no run in flight can be refused on
resume, and none of this needed a `patched` marker.

**Migrating a custom `AgentStore`:** add `setMessageToolResults(messageId, results)` — replace that
message's `toolResults` with `results`. Adapters using the bundled schemas need no migration; the
`tool_results` column already exists.
