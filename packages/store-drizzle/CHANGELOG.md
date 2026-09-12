# @dudousxd/nestjs-agent-store-drizzle

## 0.10.0

### Minor Changes

- [#101](https://github.com/DavideCarvalho/nestjs-agent/pull/101) [`a60bd23`](https://github.com/DavideCarvalho/nestjs-agent/commit/a60bd2359bcdfa51c22fea60034635a0a5b3af41) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `agent_memory` and `DrizzleMemoryProvider` — the same memory storage the MikroORM adapter gained, on
  this store's own schema and DDL pass, so a host does not pick its memory implementation by picking
  its ORM.

  - `agentSchema` gains `agentMemory`, with one unique index on (`scope`, `key`). That index is what
    the upsert conflicts against, and it doubles as the index every read uses — `list` filters
    `scope in (…)`, which is its leading column, so a second index on `scope` alone would be maintained
    on every write and read by nothing. `origin_thread_id` is deliberately not a foreign key, unlike
    every other table here: a memory outlives the conversation it came from, and a cascade off
    `agent_thread` would delete beliefs when a transcript aged out.
  - `ensureAgentSchema` creates it. It needs no entry in the additive-column pass — that list exists for
    a column added to a table this package already shipped, and `CREATE TABLE IF NOT EXISTS` covers a
    whole new one on a database of any age. `key` and `text` are quoted in the DDL: both are keywords in
    at least one engine, and they are the SPI's own field names, which is worth more than dodging the
    quoting.
  - `DrizzleMemoryProvider` implements `list`, `write` and `forget`. The scope filter is in the query;
    `forget` puts the actor's own scope in the `where`, so an id alone cannot reach a tenant's memory,
    and "no such id" and "not yours" answer identically. `write` upserts in one statement, and its
    conflict `set` names exactly what a rewrite may change — so `pinned`, `created_at` and `id` are
    left alone by construction rather than by an exclusion list anyone could forget to extend.
  - `write` refuses an **agent-authored** record at any scope but the actor's own, the storage half of
    `memoryWriteVerdict`'s third rule. A human-authored one above it is allowed: that is what a console
    publishing an organisation's policy does, and whether that person may write there needs facts a
    provider is not handed.
  - `pin({ id, pinned })` is the operator act the SPI has no method for. A pin grants a fact a permanent
    place in every future prompt, so nothing an agent can reach may set it.

  **`search` is not implemented**, for the same reason as the sibling adapter: it needs an index over
  the memories themselves, whose shape depends entirely on what a deployment already runs, and without
  it `list` reads the applicable scopes whole so the ceiling never bites. `MemoryDigest.omitted` going
  non-zero — `pinnedOmitted` especially — is the signal that it is worth building.

  `DrizzleAgentStoreModule.forRoot({ db })` exports the provider but never binds `AGENT_MEMORY`: that
  token's presence is what turns memory on, so binding it would switch the feature on for every host
  that installs the store. Name the provider in `AgentModule`'s `memory: { provider }` to opt in.

- [#106](https://github.com/DavideCarvalho/nestjs-agent/pull/106) [`2e2c04c`](https://github.com/DavideCarvalho/nestjs-agent/commit/2e2c04c50195ffcc5acdc7dca5df7e46e239230e) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The RAG ingestion ledger is no longer something only the MikroORM adapter can keep.

  `rag_ingestion_log` records the outcome of every RAG ingestion — ingested, skipped, failed, removed
  — and it is the only place a document that produced **no chunks** is visible at all. A scanned PDF
  whose extraction came back empty, a mime type with no extractor, an embedding call that blew up:
  each produces zero chunks, so `VectorStore.listDocuments()` cannot tell any of them from a document
  nobody ever uploaded. Until now that table existed for `store-mikro-orm` only, so choosing Drizzle
  silently decided that a deployment could not audit its own ingestions.

  `@dudousxd/nestjs-agent-rag` owns no storage here and never did: it publishes `aviary:rag:*`
  diagnostics, and a store _subscribes_. This release adds the Drizzle subscriber:

  - `ragIngestionLog` in `agentSchema`, created by `ensureAgentSchema` and indexed by
    (`collection`, `updated_at`) for the per-collection listing.
  - `DrizzleRagIngestionLog` — the recorder. Upserts on the document id, so the row is the document's
    _current_ state: a successful retry overwrites the failure it replaces instead of leaving a stale
    error beside a working document, and `created_at` survives, so a row still answers "when was this
    first attempted?". A sparser later event (`removed` knows the owner but not the collection) leaves
    what an earlier event recorded alone. Writes are best-effort and never throw — this runs detached
    on a diagnostics channel, so a failed write is reported and dropped rather than taking down the
    ingestion that triggered it.
  - The read path a console needs: `list`, `listPage` (page plus the unpaginated total), `get`,
    `remove`, `removeByCollection`, the delete-safe keyset `iterate`, and `listDocumentIds` for an
    orphan sweep that wants a collection's id set and not every stack trace in the table.
    `RAG_INGESTION_LOG_PAGE_ORDER` is exported because the order is a contract: `updated_at desc`
    tiebroken on the primary key, which is what keeps consecutive pages disjoint when a bulk upload
    stamps a whole batch with one timestamp.

  `DrizzleAgentStoreModule.forRoot({ db })` binds and exports it by default, the same as
  `MikroOrmAgentStoreModule.forFeature()` — a default of off would have left the gap this closes
  open for anyone who did not know to look for the switch. `{ ragIngestionLog: false }` binds nothing
  at all, for a host that records outcomes itself or ingests no media. The table has to exist:
  `ensureAgentSchema` creates it, or write the `CREATE TABLE` into your own migrations.

  **Upgrading an existing Drizzle database.** Nothing to do beyond running `ensureAgentSchema`, which
  is where a new table belongs rather than in the add-column pass: `CREATE TABLE IF NOT EXISTS` is
  only inert against a database that already has the table, and no database has this one, so it is
  created in full — every column and its index — on a database of any age.

  Both adapters' suites now assert the same behaviours in the same words, and the MikroORM side picks
  up the four its sibling exposed as untested: `created_at` surviving an upsert, the recorder going
  quiet once torn down, a page total that counts the filter rather than the page, and a write failure
  being reported instead of escaping.

### Patch Changes

- Updated dependencies [[`d7f2cf2`](https://github.com/DavideCarvalho/nestjs-agent/commit/d7f2cf260ab0e87a012b21d681f805eb6758129a), [`31caa9e`](https://github.com/DavideCarvalho/nestjs-agent/commit/31caa9e48e9b8be948b54dd252057a01355f4924)]:
  - @dudousxd/nestjs-agent-core@0.14.0

## 0.9.0

### Minor Changes

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `RecentRunRow.parentRunId` — the delegation edge reaches the read-model.

  The run row records which turn delegated it, but the governance read-model did not carry it, so every
  surface built on `recentRuns` / `runsPage` / `runDetail` / `threadDetail` still saw a flat list of runs.
  `RecentRunRow` gains `parentRunId: string | null`, mapped by all three adapters — `null` for a turn
  nobody delegated, and for any run recorded before the column existed.

  That is what a console needs to draw a delegation tree and roll a child's cost up to the turn that asked
  for it. For a DETACHED child it is the only link there is: it outlives its parent's turn, so nothing in
  the transcript pairs them.

  `RecentRunRow.status` also stops documenting three terminals. `cancelled` is a fourth value these rows
  carry, and a consumer computing a failure rate has to be able to leave it out rather than fold it into
  `failed` — a user pressing Stop is not an error.

  **Upgrading.** No schema change and no behaviour change; an existing consumer that ignores the new field
  is unaffected. A consumer asserting exhaustively on a run row (`toEqual`) will see the added key.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Make a finished turn read back as a finished turn.

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

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Persist and return a thread's `defaultAgent` on every adapter.

  `AgentStore.updateThread({ defaultAgent })` decides which agent answers the next turn on a thread
  when the caller names none. Neither SQL adapter could answer with it.

  **Drizzle had no `default_agent` column at all** — not in `schema.ts`, not in its DDL — and no
  `updateThread`, so a host on that adapter got a 501 from `PATCH /agent/threads/:id` and could never
  set the field. It now has the column, `updateThread` (title and/or `defaultAgent`, each touched only
  when present in the patch, `null` clearing the default), and the read side below.

  **MikroORM had the column and wrote it, but `toSummary` never emitted it**, so `getThread` reported
  no default agent and the next turn silently fell through to the module default. The stored value was
  reachable only by querying the entity directly, which is what its own test did — the round-trip
  through the store was never exercised.

  Both adapters now report `defaultAgent: string | null` on every thread summary/detail, and a fork
  carries the source thread's default (the in-memory reference store too — a fork continues the same
  conversation, so the same agent answers it).

  A `Required<UpdateThreadInput>` fixture in each adapter's db spec and in
  `packages/testing/src/thread-fields.spec.ts` fails to COMPILE when the patch gains a field the
  adapter does not round-trip — the same gate `message-fields.spec.ts` uses, which is what caught two
  silently-dropped message fields.

  **Upgrading.** Drizzle's `ensureAgentSchema` is `CREATE TABLE IF NOT EXISTS`, inert against a table
  that already exists, so `default_agent` is added through the additive-column pass it already runs at
  boot — an existing deployment calling `ensureAgentSchema` needs no action. A host running its own
  drizzle-kit migrations instead must add `ALTER TABLE agent_thread ADD COLUMN default_agent TEXT`.
  MikroORM needs nothing: the column already shipped.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Read the window a turn sends, not the thread's whole transcript.

  A turn loads the thread to build its prompt, and loaded it with `getThread`: every message row, every
  attachment, every tool output the thread ever recorded, all of it parsed — and then journaled, so a
  resumed run re-reads and re-parses the same payload. On a 50-turn thread whose turns each ran a 50 KB
  tool that is **1.9 MB per load, 97% of it tool results**, to send a prompt bounded to the last few
  messages.

  Both SQL stores gain `loadThreadForTurn({ threadId, messageLimit })`, returning the thread's newest
  `messageLimit` messages oldest-first, its title, its default agent, and whether the thread has ever
  been answered. The read is the database's job: `order by created_at desc limit ?` over the columns a
  model turn reads (`usage`, `follow_ups` and `run_id` stay in the table), reversed for the prompt.
  `messageLimit: 0` reads no messages at all rather than every one of them; an omitted `messageLimit`
  reads the whole thread.

  `hasAssistantMessage` is answered over the WHOLE thread — a one-row probe, not a scan of the page.
  It is what a thread-start intake asks ("has this conversation been answered before?"), and a long
  thread whose window happens to hold only the user's last questions has still been answered; computed
  off the page, such a thread re-introduces itself on every turn.

  The method is probed structurally rather than added to the `AgentStore` SPI, the same way
  `defaultAgentForThread` is: it is an optimization a store either offers or does not, and a store that
  predates it still answers correctly through the full `getThread` read.

  **Upgrading.** Nothing to run: additive method, no schema change, no behaviour change for any
  existing call. `getThread` still returns the full `ThreadDetail` and is still the right read for a
  client rendering a transcript.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - List staged attachments, and find the ones nothing points at any more.

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
  down to `list` as `stagedBefore` _and_ re-applied to the result, so a store that ignores the hint
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

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Record which run wrote each message.

  `AppendMessageInput`/`StoredMessage` gain an optional `runId`, persisted by all three store adapters,
  and the loop stamps it on the user message and on every assistant message. Until now nothing tied a
  message to a turn, so a reader could only compare timestamps against the run's `startedAt` — and a
  regenerate breaks that comparison: it truncates the replaced answer and re-answers the surviving user
  message without appending a new one, leaving one prompt followed by the newest answer. Walking
  forward by time then hands the older run the replacement's text.

  `GovernanceRunSampleSource` (`-evals`) now attributes on the stamp. A transcript carrying no stamp at
  all is treated as legacy and still resolved by time; a stamped transcript holding nothing for a run
  reads as empty for that run rather than borrowing a neighbour's answer. A regenerated run may still
  borrow the prompt it re-answered — that message genuinely is its input — but never an answer.

  The MikroORM adapter adds the column on its next boot through the schema heal it already runs. The
  Drizzle adapter's `ensureAgentSchema` was `CREATE TABLE IF NOT EXISTS` only, inert against an
  existing table, so it gains an additive-column pass that adds `run_id` where the table predates it.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Read a thread's default agent without reading the thread.

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

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The loop asks for the window, instead of taking the transcript.

  Both SQL stores could already hand a turn the messages it was about to send. Nothing asked them to:
  `runAgentLoop` loaded every thread with `getThread`, which materializes the whole transcript — every
  message row, every attachment, every tool output the thread ever recorded — to build a prompt bounded
  to its last few messages. Measured on a 50-turn thread whose turns each ran a 50 KB tool: **2.6 MB per
  load, 99% of it tool output**, paid on every turn and again on every replay. The same thread read
  through a four-message window is 103 KB.

  `ThreadTurnReader` is now a core SPI seam, and `load:thread` probes the store for it:

  ```ts
  interface ThreadTurnReader {
    loadThreadForTurn(query: {
      threadId: string;
      messageLimit?: number;
    }): Promise<ThreadTurnPage | null>;
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

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Record which run delegated a run.

  `RecordRunStartInput.parentRunId` is populated for awaited and detached children alike, by both
  runners — and all three stores dropped it on the floor. Each declared its own structural parameter
  for `recordRunStart` (`{ runId; threadId; actorRef; agentName?; promptHash? }`) instead of the SPI's
  input, so a field added to the input was accepted and discarded with nothing to fail.

  What that costs is the delegation tree. The durable runtime journals the parent→child edge, but only
  there: a reader of run ROWS — every reliability and cost surface — cannot pair a child with the turn
  that asked for it, so a delegation's spend is unattributable. For a **detached** child it is worse,
  because it outlives its parent's turn, so nothing in the transcript pairs them either.

  Both SQL adapters gain a nullable `parent_run_id` column on `agent_run` and persist it; the
  in-memory store carries it on its run row and its `GovernanceRunRow`. All three now take
  `RecordRunStartInput` itself, so the next field cannot drift the same way, and each adapter's spec
  round-trips a fixture typed `Required<RecordRunStartInput>` — which fails to COMPILE until the row
  can name what the input carries.

  The console reads the edge off `RecentRunRow`: the run drill-down names the run that delegated the
  one being read, which for a detached child is the only link back to the turn that asked for it.

  **Upgrading.** Nothing to run by hand on either adapter.

  - MikroORM: `ensureAgentSchema` heals it, and the column is appended last, so the diff is a plain
    `alter table agent_run add column parent_run_id text null` on every dialect — no SQLite table
    rebuild.
  - Drizzle: `CREATE TABLE IF NOT EXISTS` is inert against an existing table, so `parent_run_id` is
    also registered in the additive-column pass and lands on the next boot.

  Runs recorded before the upgrade keep `parent_run_id` null: the edge for a turn that has already
  finished exists only in the durable journal, and is not backfilled.

### Patch Changes

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Name `cancelled` in the row types a run settles into.

  `RecordRunEndInput.status` has three terminals — `completed`, `failed`, `cancelled` — but all three
  stores declared `recordRunEnd`'s parameter as the narrower `'completed' | 'failed'`, and their run
  row and column types listed only those. Method parameters are bivariant, so this typechecked and the
  value was written through: the data was right and every reader was told a cancelled run is
  impossible. A consumer computing a failure rate had no type-level way to leave a user pressing Stop
  out of it.

  The parameter, the `AgentRunStatus` column type on both SQL adapters, and the in-memory store's run
  rows now all name it. `DrizzleGovernanceQueries` also accepts `cancelled` as a run-status filter —
  it previously short-circuited an unrecognized value to an empty page, so an operator could not list
  the cancelled runs that were already in the table.

  Each adapter's db spec now derives its terminal fixture from `RecordRunEndInput['status']` and the
  row's own status type, so a fourth terminal fails to compile until the row can name it. A runtime
  test cannot catch this — bivariance means the value round-trips either way.

  **Upgrading.** No schema change: `status` is a plain string column on both adapters, with no enum or
  check constraint to widen.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Forking a thread no longer drops a message's `attachments` and `runId`.

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

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Accept the Drizzle database every host actually builds.

  `AgentDrizzleDb` left the schema generic at its default, `Record<string, never>`, so a handle built
  the documented way — `drizzle(client, { schema })`, which is what `agentSchema` exists for — was not
  assignable to it. `ExtractTablesWithRelations` is invariant, so the error was a wall of `Type
'"agent_thread"' is not assignable to type 'never'` at the constructor call, and the way out was a
  cast in host code.

  The type now names `TablesRelationalConfig` explicitly, which a schema-aware handle satisfies. One
  change; it cleared all 38 occurrences in this package's own db specs, which is where it was found —
  those specs are now type-checked by `pnpm typecheck:specs`, so the next one fails the build instead
  of being invisible to CI.

  **Upgrading.** Nothing to run. A host that worked around this with a cast can drop it.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Let an agent ask the user a structured question, and wait.

  The only way a run could pause for a human was `awaitApproval` — a yes/no about a tool call already
  proposed, mid-work. The other direction was missing entirely: collecting the SCOPE, before the work,
  while changing course is still cheap. Two surfaces now do it, and they were built to be
  indistinguishable downstream.

  **A configured intake.** `@Agent({ intake: { questions, preamble?, when? } })` declares the questions;
  the turn passes through them before its first model call. Because they are authored, the intake costs
  **no model call** and writes no usage row — and `questions.length` is known before the form appears,
  which is the only honest way a client can render "Question 1 of 3" rather than discovering a fourth
  halfway through. `when: 'thread-start'` (the default) asks once per thread; `'every-turn'` asks before
  each one.

  **A model-callable `ask`.** `forRoot({ ask: true })` (or `@Agent({ ask })`) offers the model a built-in
  `ask` tool for the case an intake cannot anticipate. Its input schema _requires_ a pre-picked
  `defaults` on every question: "I have pre-picked what I would choose, so confirming is enough" is the
  claim the surface rests on, and a schema is the only place to make it mandatory rather than
  aspirational. A malformed question set comes back as an ordinary tool failure carrying the validation
  issues, so the model fixes its own mistake instead of failing the run or parking a person.

  **One shape, one resume path.** Both write a single pending tool-call row named `ask`
  (`toolType: 'action'`, `status: 'pending_approval'`, so it surfaces in the existing approvals inbox),
  both emit the same new `elicitation` stream frame followed by the ordinary `tool-output` frame, and
  both park on the same `tool:<runId>:<callId>` durable signal a HITL approval already waits on. New
  `POST /agent/tool-call/answer` and `/skip` mirror `approve`/`reject`, with the same ownership check.
  `AgentLoopHooks` gains an optional `awaitAnswers`; a host that only implemented `awaitApproval` still
  completes an elicitation, reading approve as "confirmed the pre-picked answers" and reject as "skipped".

  **An omitted question takes its own default**, resolved server-side against the request the run
  already holds rather than in the client — so "just pressed enter" and "picked exactly the defaults"
  persist identically, and a client that never rendered the defaults cannot submit a blank. The settled
  row records `defaulted: string[]` so an auditor can still see which questions a human touched.
  **A skip is not a confirmation:** it lands on the same values, and persists as `rejected` rather than
  `executed`, because proceeding on an assumption the user declined to confirm is a different fact from
  proceeding on one they chose. Nobody answering parks the run indefinitely, exactly as an approval
  does — there is no intake timeout, because a timeout that applied the defaults would manufacture
  consent from silence.

  `ToolKind` gains a fourth member, `'ask'`. No `ToolSpec` carries it: `ask` is never registered, has no
  handler, and is offered to the model straight from module config — so the branch that decides whether
  a call parks on a human can never be settled by a process-local registry lookup. As with the other
  kinds, the value is resolved INSIDE the already-journaled `persist:toolcall:<callId>` checkpoint and
  read back from there on every replay.

  **Checkpoints.** An intake spends one position for its verdict (`intake:ask`) plus two more on the
  turns it asks; an `ask` reuses the approval path's own names and adds one (`stream:elicitation:<id>`).
  The intake's verdict is RETURNED from `intake:ask` rather than recomputed, because by the time a
  resume replays the turn the first attempt has already appended the intake's own assistant message to
  the thread — recomputing "has this thread been asked?" would answer no on the way in and yes on the way
  back, and land `stream:step-start:0` where the history holds `signal:tool:`. No `patched` marker is
  spent for either surface: an intake is reachable only through new config and an `ask` only through a
  journaled kind no existing run recorded, so no in-flight run can land on any of these positions.
  Declare neither and a turn's checkpoint sequence is byte-identical.

  `AgentStore.runForToolCall` now answers from the tool call's OWN `runId`, falling back to the thread's
  `activeStreamId` only for rows written before calls carried one. Keying off the active stream assumed
  a thread holds exactly one live run; it is about to hold more, and then the answer would reach a run
  waiting on nothing. Fixed in all three shipped adapters.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Declare an index on `agent_tool_call.message_id`.

  The column carried a foreign key and no index. MySQL indexes a foreign key column for you; **Postgres
  does not** — and both message-scoped reads filter on it: the thread reader's `IN (…)` over a turn's
  calls, and `truncateFrom`'s delete of everything from a message onward.

  `agent_tool_call_message_idx` is now declared in `schema.ts` and created by `ensureAgentSchema`.

  The MikroORM adapter needs no change: the ORM's schema generator indexes every `m:1` on every SQL
  platform (`AbstractSqlPlatform.indexForeignKeys()`), so `agent_tool_call_message_id_index` already
  ships there — a second declared index would be a duplicate on every dialect. Its db spec now pins
  that coverage rather than assuming it.

  **Upgrading.** `ensureAgentSchema` issues `CREATE INDEX IF NOT EXISTS` on every boot, so an existing
  deployment picks it up with no action. A host on its own drizzle-kit migrations must add
  `CREATE INDEX agent_tool_call_message_idx ON agent_tool_call (message_id)`.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Persist a message's `attachments` in the Drizzle and in-memory stores.

  `AppendMessageInput` has carried `attachments` all along and the MikroORM adapter persisted them,
  but the Drizzle adapter had no such column — not in its `schema.ts`, not in its DDL — and neither it
  nor the in-memory store wrote the field. So the same conversation round-tripped differently
  depending on which adapter the host had wired: a user attached a PDF, reopened the thread, and it
  was gone, with nothing logged. `ensureAgentSchema` adds the column to a table that predates it.

  A round-trip test now asserts that every field `appendMessage` accepts comes back out of
  `getThread`, which is the check whose absence let a whole field go unwritten.

- Updated dependencies [[`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4)]:
  - @dudousxd/nestjs-agent-core@0.13.0

## 0.8.2

### Patch Changes

- [`fe9fb99`](https://github.com/DavideCarvalho/nestjs-agent/commit/fe9fb9985131643ad9b2733a3c3658decdc585ab) - Add NestJS 12 to the supported peer range.

  Every `@nestjs/common`, `@nestjs/core` and `@nestjs/platform-express` peer that read
  `^10.0.0 || ^11.0.0` now reads `^10.0.0 || ^11.0.0 || ^12.0.0`. NestJS 12.0.1 shipped the framework
  as pure ESM and raised its floor to Node >= 20.19; these packages are already `"type": "module"`,
  so nothing needed porting — the turn loop, the `/api/agent/*` controllers, HITL approval as a durable
  signal, the stores and the dashboard all behave identically on 11 and 12.

  The dev and test matrix moved to the 12.x line with the ranges, including the demo app, so the added
  range is tested rather than merely declared: build, both typecheck passes, and the unit and
  database suites are green against 12.0.1.

  11 and 10 stay in every range. Nothing in the source depends on a 12-only API, so the widened range
  is additive and a consumer still on 11 sees no change.

## 0.8.1

### Patch Changes

- Updated dependencies [[`70f3d57`](https://github.com/DavideCarvalho/nestjs-agent/commit/70f3d57dcebd9aec631adc66c40d0715472115d9)]:
  - @dudousxd/nestjs-agent-core@0.12.0

## 0.8.0

### Minor Changes

- [#56](https://github.com/DavideCarvalho/nestjs-agent/pull/56) [`7c27376`](https://github.com/DavideCarvalho/nestjs-agent/commit/7c273763eeb6d5841028612d81acc63b2a8dd4eb) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Page the approvals inbox, open a run or a thread, and report p50 next to p95

  The governance read-model could answer "what happened" but not "how much of it is there" or
  "what happened _here_". Three gaps, one shape of fix.

  **The approvals inbox was capped and silently truncating.** `pendingApprovals(limit)` returns a
  capped list with no total, so a backlog past the cap was invisible — nothing on screen said so.
  That is the worst failure a human-in-the-loop queue can have. `approvalsPage` gives it the same
  paged treatment `runsPage`/`threadsPage`/`toolCallsPage` already have, with a `total` and filters
  on `toolName`/`threadId`/`actorRef`/`agentName`/day bounds, exposed as `GET approvals-page`.
  Ordering is `createdAt asc, id asc` — the `id` makes it a total order, and ascending means a newly
  requested approval appends past the last page instead of shifting the page an operator is reading.
  `GET approvals` stays: the console's own SPA still calls it, and telescope's inbox table reads the
  SPI method directly. Telescope's pending-approvals STAT now reads `approvalsPage(...).total`, which
  replaces an explicitly-documented undercount (it counted a 500-row capped list).

  **Every table row was a dead end.** `runDetail(runId)` returns a run, its owning thread's headline
  and its tool calls; `threadDetail({ threadId, messageLimit, runLimit })` returns a thread, its
  lifetime token/cost rollup, its newest runs and its newest messages. One round trip each, and a
  fixed query count inside — per-message tool-call counts are one batched read, not one per message.
  Exposed as `GET runs/:runId` and `GET threads/:threadId`, 404 on an unknown id (a console that
  renders an empty detail instead sends an operator hunting a bug that isn't there). A soft-deleted
  thread is returned flagged `deleted: true` rather than 404'd — an audit needs the thread it just
  lost. Run detail carries no cost figure: the token ledger has no run column, so per-run spend is
  not attributable without a store migration, and inventing a number would be worse than omitting it.

  **`toolStats` reported only a tail.** It had p95 and no measure of the typical call, so a tool whose
  median is 100ms and whose p95 is 10s looked the same as one that is uniformly slow. Added
  `p50ExecutionMs` alongside. Not a mean: latency is long-tailed, and an average of nine 100ms calls
  and one 10s call is ~1s — a number no call in the sample ever produced. Percentiles stay in-process
  off the sorted sample, as they already were, because MySQL has no `PERCENTILE_CONT` and one portable
  implementation beats three dialect-specific ones.

  Also in this change:

  - `where[threadId]` on `GET runs-page` now works. Every adapter's `RunWhere` already supported it;
    only the query parser rejected it, so "show me this thread's runs" 400'd with "Unknown where
    field" — exactly the follow-up query a drill-down leads to.
  - `recentThreads`/`threadsPage` no longer issue two queries per row. Both SQL adapters batch the
    message counts and token totals across the whole page, so a 200-row page costs two statements
    instead of four hundred round trips.
  - The typed client (`@dudousxd/nestjs-agent-dashboard/client`) gains `approvalsPage`, `runDetail`
    and `threadDetail`, and picks up `runId` on the tool-call and pending-approval rows — the server
    had been sending it and the mirror had drifted.

  `AgentGovernanceQueries` gains three required methods (`approvalsPage`, `runDetail`,
  `threadDetail`), matching how the paged reads were added. An out-of-tree adapter implementing the
  interface must add them; all three in-tree adapters (MikroORM, Drizzle, in-memory) do.

### Patch Changes

- Updated dependencies [[`7c27376`](https://github.com/DavideCarvalho/nestjs-agent/commit/7c273763eeb6d5841028612d81acc63b2a8dd4eb)]:
  - @dudousxd/nestjs-agent-core@0.11.0

## 0.7.1

### Patch Changes

- Updated dependencies [[`70114eb`](https://github.com/DavideCarvalho/nestjs-agent/commit/70114ebb9a7a3702d2efdb11e0dea6956a7ba8db)]:
  - @dudousxd/nestjs-agent-core@0.10.0

## 0.7.0

### Minor Changes

- [`107fcc2`](https://github.com/DavideCarvalho/nestjs-agent/commit/107fcc2c0079f97c3cc9ff8c83f2dc41070244d5) - Trace navigation + paged Agent tab + headless docs:

  - Tool calls carry their `runId` end to end (RecordToolCallInput → both stores' nullable run_id →
    ToolCallActivityRow/PendingApprovalRow), and `RunWhere.threadId` filters runs by thread — every
    activity row can now deep-link to its run's trace.
  - Telescope Agent tab: tool-call/run rows link to the TRACES waterfall (`#/traces/{runId}`,
    internal default); the three activity tables use the paged SPI reads with real pagination
    controls (`paged: true`, telescope >= 1.18, dep floor raised); the dashboard regrouped into six
    coherent sections with no orphan half-width panels.
  - react README documents "Bring your own UI" — the package is headless by design; the snippets
    compile against the current API.

### Patch Changes

- Updated dependencies [[`107fcc2`](https://github.com/DavideCarvalho/nestjs-agent/commit/107fcc2c0079f97c3cc9ff8c83f2dc41070244d5)]:
  - @dudousxd/nestjs-agent-core@0.9.0

## 0.6.0

### Minor Changes

- [`3d256d4`](https://github.com/DavideCarvalho/nestjs-agent/commit/3d256d4027c7ad819f8ec908425d52887e67da3f) - Console navigability + paginated, queryable lists:

  - Sections live on ROUTES now — hash routing (`/ai-gateway#/reliability`, `#/approvals`, …),
    deep-linkable on full page load, consistent with the durable console, zero new dependencies.
  - The list surfaces (tool calls, threads, runs) are paginated and filterable end to end:
    `AgentGovernanceQueries` grew `toolCallsPage`/`threadsPage`/`runsPage` (neutral
    `GovernancePageQuery` with typed `where` — REQUIRED members, implemented in both bundled stores
    with real COUNT + offset, deterministic id tiebreaks, case-insensitive title search, one-sided
    day bounds; in-memory testing impls included). The dashboard API speaks the ecosystem's familiar
    wire grammar (`page`, `limit`, `where[field]=value`, unknown field → 400) and the SPA tables get
    prev/next pagination with per-table debounced filters. The latest-N reads remain for the
    telescope bridge.

### Patch Changes

- Updated dependencies [[`3d256d4`](https://github.com/DavideCarvalho/nestjs-agent/commit/3d256d4027c7ad819f8ec908425d52887e67da3f)]:
  - @dudousxd/nestjs-agent-core@0.8.0

## 0.5.1

### Patch Changes

- Updated dependencies [[`6263338`](https://github.com/DavideCarvalho/nestjs-agent/commit/6263338cf86df7b51cb082d5d2d575987cd13383)]:
  - @dudousxd/nestjs-agent-core@0.7.0

## 0.5.0

### Minor Changes

- [`eb3aaff`](https://github.com/DavideCarvalho/nestjs-agent/commit/eb3aaff531cc923de1d0bccebb2b0690b4c92263) - Governance wave — approvals inbox, tool stats, prompt hash:

  - **HITL approvals inbox**: new `AGENT_APPROVAL_PORT` SPI (`AgentApprovalPort`) bound by the agent
    runtime — console-side approve/reject routed through the SAME decision path chat approvals use
    (durable signal or inline resolution), WITHOUT re-authorization (the console's own guards front
    it). `Decision` gained optional `executedByRef`; the loop persists the decider on both executed
    and rejected action tools (`decision.executedByRef ?? the run's actor`). Governance read
    `pendingApprovals(limit)` (oldest first, joined to thread/actor). Dashboard: Approvals section
    (pending list, approve/reject with reason, nav badge) + `GET approvals` / `POST
approvals/:toolCallId`; new `approvalActorRef` dashboard option stamps WHO decided from the live
    request; the API returns 501 (and the SPA renders read-only) when no port is bound.
  - **Tool governance**: `toolStats(range)` — per-tool calls/failed/rejected + p95 executionMs —
    and a dashboard Tools section.
  - **Prompt hash**: each run records the sha256 of its resolved system prompt (pre-RAG, so it
    identifies the prompt VERSION), surfaced on recent runs in the dashboard — correlate error-rate
    shifts with prompt changes.

### Patch Changes

- Updated dependencies [[`eb3aaff`](https://github.com/DavideCarvalho/nestjs-agent/commit/eb3aaff531cc923de1d0bccebb2b0690b4c92263), [`781a30f`](https://github.com/DavideCarvalho/nestjs-agent/commit/781a30f6579d5b9a69f341b8eeac02c273dbb8a1)]:
  - @dudousxd/nestjs-agent-core@0.6.0

## 0.4.0

### Minor Changes

- [`1c44152`](https://github.com/DavideCarvalho/nestjs-agent/commit/1c4415295a6280527e762f13e6aed48099ae5ca5) - Run reliability metrics — run outcomes are now durably recorded and surfaced as governance reads
  and a dashboard Reliability section:

  - Store SPI: optional `recordRunStart`/`recordRunEnd`/`bumpRunRetries` on `AgentStore` (absent =
    graceful no-op). The loop records start/completed (with duration) as checkpointed steps; the
    runners (durable workflow + inline) record failures with error code/message. Both bundled store
    adapters ship the new `agent_run` table (autoSchema-managed, in the managed-tables lists).
  - `AgentGovernanceQueries` grew `runMetrics`, `runsByAgent`, `runErrors`, `runTrend`, `recentRuns`
    (REQUIRED members — external adapters must implement them; return zeros/empty when the backing
    store never records runs). In-memory testing impls included.
  - Dashboard: `GET <api>/reliability?from&to` + `GET <api>/runs?limit`, and a Reliability section in
    the SPA — success/error rate, retries, p95 duration, run/failure trend, failure breakdown by
    error code, recent runs table.
  - `DispatchedLlmInput` carries `runId` so llm-step retries can be attributed to the run; the retry
    counter stays 0 until the durable runtime exposes the attempt number to remote step handlers.

### Patch Changes

- Updated dependencies [[`1c44152`](https://github.com/DavideCarvalho/nestjs-agent/commit/1c4415295a6280527e762f13e6aed48099ae5ca5), [`1c44152`](https://github.com/DavideCarvalho/nestjs-agent/commit/1c4415295a6280527e762f13e6aed48099ae5ca5)]:
  - @dudousxd/nestjs-agent-core@0.5.0

## 0.3.4

### Patch Changes

- Updated dependencies [[`abb32bc`](https://github.com/DavideCarvalho/nestjs-agent/commit/abb32bc0396c65a59ee2b92a1a8b07d772215e31)]:
  - @dudousxd/nestjs-agent-core@0.4.0

## 0.3.3

### Patch Changes

- Updated dependencies [[`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46), [`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46), [`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46)]:
  - @dudousxd/nestjs-agent-core@0.3.3

## 0.3.2

### Patch Changes

- ad8e446: Behavior-preserving simplification pass across the governance surfaces.

  - **core**: extract the shared, pure governance aggregation helpers
    (`estimateCost`, `bucketByModel`, `bucketByActor`, `bucketByThread`,
    `bucketUsageTrend`, `dayBoundsUtc`) so the cost formula, bucketing, and
    day-bounds math live in one place.
  - **store-mikro-orm / store-drizzle / testing**: the three
    `AgentGovernanceQueries` adapters now only fetch their DB-specific rows,
    map them to the shared `GovernanceUsageInput` shape, and call the core
    helpers — deleting the duplicated cost/bucket/day-bounds code.
  - **codegen**: fix the `USAGE`/`StoredMessage` wire contracts that had
    drifted from core's real types, and inject the four missing controller
    routes (agents catalog, thread rename/promote/truncate-from-message).
  - **telescope**: collapse the eight governance data providers into a single
    `governanceStatProvider(name, fetch, format)` factory.

- Updated dependencies
- Updated dependencies [ad8e446]
  - @dudousxd/nestjs-agent-core@0.3.2

## 0.3.1

### Patch Changes

- [`60dcc7d`](https://github.com/DavideCarvalho/nestjs-agent/commit/60dcc7db3764a7d60cb6e4d586f1c0fe7b05ee04) - Governance queries: add `spendByThread(range, limit)` (top threads by cost) and
  `ActorSpendRow.threadCount`. Cost is now priced through the injected
  `AGENT_PRICING_STORE` instead of reading `agent_model_pricing` directly, and both
  store modules accept a `pricingStore` option so a host can bind its own pricing
  table as the single source of cost truth for every governance surface. Default
  behavior (the store's own pricing table) is unchanged.

  The dashboard (`/ai-gateway`) and the Telescope Agent tab gain a "Top threads by
  cost" panel fed by `spendByThread`.

- Updated dependencies [[`60dcc7d`](https://github.com/DavideCarvalho/nestjs-agent/commit/60dcc7db3764a7d60cb6e4d586f1c0fe7b05ee04)]:
  - @dudousxd/nestjs-agent-core@0.3.1
