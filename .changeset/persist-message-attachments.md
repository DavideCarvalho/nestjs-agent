---
'@dudousxd/nestjs-agent-store-drizzle': patch
'@dudousxd/nestjs-agent-testing': patch
---

Persist a message's `attachments` in the Drizzle and in-memory stores.

`AppendMessageInput` has carried `attachments` all along and the MikroORM adapter persisted them,
but the Drizzle adapter had no such column — not in its `schema.ts`, not in its DDL — and neither it
nor the in-memory store wrote the field. So the same conversation round-tripped differently
depending on which adapter the host had wired: a user attached a PDF, reopened the thread, and it
was gone, with nothing logged. `ensureAgentSchema` adds the column to a table that predates it.

A round-trip test now asserts that every field `appendMessage` accepts comes back out of
`getThread`, which is the check whose absence let a whole field go unwritten.
