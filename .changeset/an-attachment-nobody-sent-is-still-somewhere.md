---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
'@dudousxd/nestjs-agent-store-drizzle': minor
'@dudousxd/nestjs-agent-store-mikro-orm': minor
'@dudousxd/nestjs-agent-testing': minor
---

List staged attachments, and find the ones nothing points at any more.

`stage()` creates media at upload time, before any message exists. A user who attached a file and
then closed the tab left bytes in the host's object store with nothing referencing them — no
message, no listing, no sweep, no way to even measure how much was there. In a product where an
attachment may be a contract or a medical record, keeping it for ever by omission is the worse
default.

The two sides of the problem are held by different owners, so neither could answer alone, and both
now have a method:

- **The host owns the bytes.** `AttachmentStagingStore` gains optional
  **`list({ actor, stagedBefore?, limit? })` → `StagedAttachment[]`** — `mediaId`, `name`,
  `contentType`, `sizeBytes`, `createdAt`. Deliberately no `url`: a url is minted per turn by
  `resolve` so it can be short-lived, and a listing that returned one per row would undo that just
  to render a file list.
- **The library owns the references.** `AgentStore` gains optional
  **`referencedMediaIds(actorRef, mediaIds)` → `string[]`**, the inverse query: of these ids, which
  a message that still exists carries. Implemented in `store-mikro-orm`, `store-drizzle` and
  `InMemoryAgentStore`.

`AgentService.collectableAttachments(actor, { olderThan })` composes them into the candidate set for
a sweep — inventory, minus references, minus anything too recent to be garbage. It returns
candidates and **never deletes anything**: the bytes are the host's, and so is the decision.
`AgentService.listAttachments(actor)` and `GET /agent/attachments` expose the inventory itself.

**References are re-derived, never latched.** `truncateFrom` deletes messages — which is exactly
what regenerating a turn does — so media that was referenced becomes unreferenced again. A flag set
when a message is sent would never be unset by that delete and would pin the bytes for ever. Every
call answers from the surviving message rows instead.

**`olderThan` is required and has no default.** Freshly staged media is an upload in flight, not
garbage. How long a composer may sit open with a file attached is the host's knowledge, and a
library-chosen grace period would eventually delete a file someone was about to send. It is pushed
down to `list` as `stagedBefore` *and* re-applied to the result, so a store that ignores the hint
cannot turn this into that bug silently.

**Both halves must answer or the sweep refuses** (`501`). An unanswerable reference query means
"cannot tell", and reading it as "nothing is referenced" would hand back every attachment the actor
ever sent, marked safe to delete.

**No schema change.** `referencedMediaIds` reads the `attachments` JSON column that has carried
message attachments since they shipped, so there is nothing to migrate and nothing to backfill — an
existing deployment gets correct answers on its existing rows the moment it upgrades. A normalized
index table would have been faster to query and would have reported every attachment written before
the backfill as unreferenced, which on a delete path is the one failure mode worth designing out.

Both reads are per-actor without exception, and `GET /agent/attachments` has no `threadId` filter:
a thread's attachments already ride on its messages in the thread payload, so a second ownership
path would be new risk for information the client already has. Collection is not an HTTP route at
all — it needs a host-chosen threshold and ends in deleting files, so it stays an in-process call.

`@dudousxd/nestjs-agent-testing` also gains `InMemoryAttachmentStagingStore`, a complete staging
store (including the per-actor checks) for testing a sweep end to end.
