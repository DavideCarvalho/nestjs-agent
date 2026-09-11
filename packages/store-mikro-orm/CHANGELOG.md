# @dudousxd/nestjs-agent-store-mikro-orm

## 0.15.0

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

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Heal the schema on SQLite, and refuse to record a heal that did not apply.

  `ensureAgentSchema` kept the statements of the update diff whose target table is an agent table. On
  MySQL and Postgres a missing column is `alter table agent_thread add column …`, which that keeps. On
  SQLite/libsql there is no such statement: MikroORM rewrites the table — `create table
agent_thread__temp_alter`, `insert … select`, `drop table`, `rename to` — and every one of those was
  filtered out, the temp table not being in the owned set and `insert`/`drop` not being matched at all.

  So the heal ran, applied nothing, raised nothing — and then wrote the fingerprint, which is the part
  that made it permanent: every later boot compared fingerprints, matched, and returned before ever
  looking at the database again. Measured on a thread table missing four columns, the heal left
  `id, actor_ref, title, transient, created_at, updated_at` and reported success.

  Two changes, either of which would have caught it:

  - The statement filter now keeps a statement when EVERY table it names is one this store owns —
    which admits the whole rebuild sequence, and is also what keeps its `drop table` from ever pointing
    at a host table. On SQLite the rebuild runs with foreign-key enforcement off and restored
    afterwards: dropping `agent_thread` with enforcement on fires the children's `on delete cascade`,
    taking every message, tool call and usage row with it.
  - The heal then re-diffs, and throws the new `AgentSchemaHealError` when structure the diff asked for
    is still pending. The fingerprint is written only on the way out, so a heal that did not happen
    cannot record itself as the applied schema — the next boot introspects again instead of returning
    early forever.

  **Upgrading.** Nothing to run. A deployment whose agent tables are already current sees no change:
  the diff is empty, so there is nothing to apply and nothing pending. A SQLite/libsql deployment that
  silently missed a column heals on the next boot — the rebuild preserves the rows, and the fingerprint
  is recorded only once the columns are actually there. A deployment whose database rejects the DDL
  (no DDL grant, a managed schema) now fails the boot loudly with the pending statements in the
  message, instead of starting against a schema the store cannot use; apply them from
  `agentSchemaSql()` in a migration.

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

## 0.14.1

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

## 0.14.0

### Minor Changes

- [#72](https://github.com/DavideCarvalho/nestjs-agent/pull/72) [`85fc4ec`](https://github.com/DavideCarvalho/nestjs-agent/commit/85fc4ec944c6d271b122589847199a834cd03a49) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Ship a custom `EntityRepository` per agent entity — `AgentThreadRepository`, `AgentMessageRepository`, `AgentToolCallRepository`, `AgentTokenUsageRepository`, `AgentModelPricingRepository`, `AgentRunRepository` and `RagIngestionLogRepository`.

  Each is wired into its `EntitySchema` and declared on the entity class via `[EntityRepositoryType]`, so a host app can resolve one by type — `em.getRepository(RagIngestionLog)` or `@InjectRepository(RagIngestionLog)` in a Nest provider — instead of passing the entity class to every `em.find(RagIngestionLog, …)` call. The generated schema is unchanged: the boot fingerprint in `ensureAgentSchema` hashes tables, columns, indexes and collation only, so no host re-heals.

## 0.13.0

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

- [#59](https://github.com/DavideCarvalho/nestjs-agent/pull/59) [`d115cb7`](https://github.com/DavideCarvalho/nestjs-agent/commit/d115cb7973aafa539eafbb1e488259044a562069) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Stop a `core` minor from promoting half the monorepo to 1.0.0.

  Five packages declared their peer dependency on `@dudousxd/nestjs-agent-core` as `workspace:*`. Changesets treats a peer-dependency bump as breaking for the dependent, and "breaking" on a `0.x` package means `1.0.0` — so the moment `core` took a minor, `ai-sdk`, `rag`, `store-mikro-orm`, `testing` and `transport-redis` were all queued to publish as `1.0.0`. `rag-media` went with them by cascade: its own range on `core` was correct, but its `>=0.4.0 <1.0.0` on `rag` stopped being satisfied once `rag` majored.

  The ranges are now `>=0.10.0 <1.0.0`, matching what `dashboard` and `rag-media` already declared. `onlyUpdatePeerDependentsWhenOutOfRange` is already set in the changesets config, and with a range that a `0.11.0` core still satisfies it does its job. `dashboard` is the control: it peer-depends on `core` too, and it was the one package that did _not_ major, because its range was written this way from the start.

  Verified by running `changeset version` against the same set of changesets before and after: six `1.0.0` bumps become the minors and patches those changesets actually asked for.

  Consumers would have felt this as silence rather than breakage. A dependant on `^0.7.0` of `rag` does not match `1.0.0`, so it simply stops receiving updates, with nothing failing anywhere to say so.

## 0.12.0

### Minor Changes

- [#45](https://github.com/DavideCarvalho/nestjs-agent/pull/45) [`f4c997b`](https://github.com/DavideCarvalho/nestjs-agent/commit/f4c997b5d030f9595678842a21e99cfc3d34c297) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `MikroOrmRagIngestionLog.iterate()`: a keyset sweep that survives deleting as you go

  The log only offered `list`/`listPage` with `limit`/`offset`, so every consumer that had to walk the
  whole table hand-rolled the paging. Two of them delete rows mid-sweep — an orphan reconcile drops the
  log row for each document it removes — and offset paging cannot express that: a deleted row shifts
  every row behind it back by one, so the next `OFFSET` lands past rows nobody ever saw. The workaround
  is to advance the offset by only the rows you _kept_, arithmetic that needs a paragraph of comment to
  justify and is wrong the moment anything else deletes concurrently.

  - **`iterate(where?, options?)`** — an `AsyncIterable<RagIngestionLog>` over every matching row.
    Paging is keyset, not offset: each batch asks for the rows sorting strictly after the last row
    yielded, using `(updatedAt, documentId)` — a point in the page order, total because it ends in the
    primary key. A cursor made of column values read off a row already in hand does not move when rows
    leave the table, so **deleting while iterating is safe by construction**, including when every row
    shares one `updatedAt` (a bulk upload) and only the tiebreaker separates the batches.
    `options.batchSize` sets the rows per round-trip (default 200), `options.after` resumes from a
    cursor an earlier sweep stopped on. Each batch runs on a **fresh forked EntityManager**, so a long
    sweep does not accumulate an identity map of every row it ever saw.

    The guarantee is stated exactly on the method, including what it is _not_: it is not a snapshot.
    A row inserted or re-ingested mid-sweep is stamped `now`, which sorts ahead of a cursor already
    past it, so against a concurrent writer `iterate` is "at most once", not "at least once".

  - **`listDocumentIds(where?, options?)`** — every matching document id, in page order, with no
    200-row cap. It sweeps on the same keyset and selects two columns instead of hydrating whole
    entities, so collecting the id set of a collection no longer drags every `error` TEXT column
    through the heap to discard it.

  - **`listPage({ orderBy })`** — the page order is now overridable and documented, and the constant is
    exported as `RAG_INGESTION_LOG_PAGE_ORDER`. Callers that needed a different order were bypassing
    the class entirely rather than depending on an undocumented internal. **The default is unchanged**
    (`updatedAt` desc, `documentId` asc); omitting `orderBy` behaves exactly as before.

  Also exported: `RagIngestionLogWhere`, `RagIngestionLogPageQuery`, `RagIngestionLogCursor`,
  `RagIngestionLogIterateOptions`. Purely additive — no existing signature or default changed.

## 0.11.2

### Patch Changes

- [#30](https://github.com/DavideCarvalho/nestjs-agent/pull/30) [`f28db24`](https://github.com/DavideCarvalho/nestjs-agent/commit/f28db244b64fa25c054503bdf8469d53000219b1) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - **`MikroOrmRagIngestionLog.list()` / `listPage()` now page deterministically — a document can no longer fall between two pages.**

  Both methods ordered by `updatedAt DESC` with no tiebreaker before applying `limit`/`offset`. `updatedAt` is not a total order: a bulk upload stamps every document of the batch with the same second, and the database is free to return tied rows in a different sequence for each LIMIT/OFFSET query. A tie straddling a page boundary therefore handed a caller sweeping the table a row in _neither_ page — or the same row in both.

  The ordering is now `{ updatedAt: 'desc', documentId: 'asc' }`. `documentId` is the entity's primary key, so the order is total and consecutive pages are disjoint.

  This mattered most to callers that sweep the whole table rather than render one page. A missed row means an orphan cleanup deletes the log row while leaving the document's storage object behind unreferenced and unfindable, and a reconcile pass re-embeds documents it already has while reporting inflated counts. Within a page the visible ordering is unchanged except that rows tied on `updatedAt` are now returned in a stable, id-ascending sequence instead of an arbitrary one.

## 0.11.1

### Patch Changes

- [#24](https://github.com/DavideCarvalho/nestjs-agent/pull/24) [`287a720`](https://github.com/DavideCarvalho/nestjs-agent/commit/287a7209a1a89e540f237afd771c65d155601a5e) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The RAG ingestion-log recorder now writes via MikroORM's native `em.upsert(...)` instead of find-then-insert. Two concurrent events for the same new document could race to a duplicate-key insert, which the best-effort catch degraded to a warning — silently dropping the row. The upsert makes insert-or-update atomic while preserving the existing contracts: coordinates a sparser later event omits are left untouched, the outcome-specific columns (`chunks`/`reason`/`error`) stay exclusive per status, and `createdAt` is preserved on update via `onConflictExcludeFields`.

## 0.11.0

### Minor Changes

- [#22](https://github.com/DavideCarvalho/nestjs-agent/pull/22) [`faa6c01`](https://github.com/DavideCarvalho/nestjs-agent/commit/faa6c014a1972a3cebac82d87a2b5c382d5c551b) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Round out `MikroOrmRagIngestionLog` with the operations a document listing actually needs.

  - `remove(documentId)` / `removeByCollection(collection)` — deleting a document from a knowledge base
    has to clear its record too, and deleting a collection has to clear all of them. Without these a
    caller had to reach past the service into the entity manager.
  - `listPage()` returns `{ rows, total }`, and `list()` accepts `offset`. The existing `list()` capped
    at 200 with no way to tell a full result from a truncated one, so a caller rendering it had no
    way to know it was showing a partial list — silent truncation reads as completeness.

## 0.10.0

### Minor Changes

- [#20](https://github.com/DavideCarvalho/nestjs-agent/pull/20) [`fc2981f`](https://github.com/DavideCarvalho/nestjs-agent/commit/fc2981f2ed56ddb46ed7adaa5ea1b65b35d9cbbe) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add `rag_ingestion_log` and `MikroOrmRagIngestionLog` — a record of what RAG ingestion _attempted_.

  A vector store can only enumerate what it has: a document whose extraction produced no text, whose
  mime type had no extractor, or whose embedding call failed has zero chunks, and is therefore
  invisible to `VectorStore.listDocuments()`. Without this, a scanned PDF that silently failed to index
  is indistinguishable from one that was never uploaded.

  The service subscribes to the four `aviary:rag:*` channels `@dudousxd/nestjs-agent-rag-media`
  publishes and upserts one row per document id, so the row always reflects the current state — a
  successful retry clears the error it replaces. It couples to the channel wire contract rather than
  importing `rag-media` (the same convention `rag-media` uses for the media channels it consumes), so
  no new dependency. Writes are best-effort and never throw; a lost row costs observability, not data.

  Registered by `MikroOrmAgentStoreModule.forFeature()` by default — pass `{ ragIngestionLog: false }`
  to opt out. The new table is included in `agentEntities()` and `agentManagedTables()`, so `autoSchema`
  creates it and a host's migration differ skips it.

## 0.9.1

### Patch Changes

- Updated dependencies [[`70114eb`](https://github.com/DavideCarvalho/nestjs-agent/commit/70114ebb9a7a3702d2efdb11e0dea6956a7ba8db)]:
  - @dudousxd/nestjs-agent-core@0.10.0

## 0.9.0

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

## 0.8.0

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

## 0.7.1

### Patch Changes

- Updated dependencies [[`6263338`](https://github.com/DavideCarvalho/nestjs-agent/commit/6263338cf86df7b51cb082d5d2d575987cd13383)]:
  - @dudousxd/nestjs-agent-core@0.7.0

## 0.7.0

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

## 0.6.0

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

## 0.5.0

### Minor Changes

- [#3](https://github.com/DavideCarvalho/nestjs-agent/pull/3) [`abb32bc`](https://github.com/DavideCarvalho/nestjs-agent/commit/abb32bc0396c65a59ee2b92a1a8b07d772215e31) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Implements the (optional) `AgentStore.updateThread` and `AgentStore.activeRunForThread` SPI methods.
  `updateThread` patches `title`/`defaultAgent` — each field only touched when present in the patch, so
  a title-only update never has to know the current `defaultAgent` to preserve it; `defaultAgent` is a
  new additive, nullable column on `agent_thread`, healed in via the existing fingerprint-gated
  `ensureAgentSchema` (no migration). `activeRunForThread` reads the same `activeStreamId` field
  `setActiveStream` already writes — the reverse lookup, keyed by threadId, that lets a client
  reconnecting after a refresh discover a run to reattach to.

  Exports `agentManagedTables()` — the five agent table names, derived from the store's existing
  internal set (never a hand-maintained parallel list) — for a host's own MikroORM schema-diff
  `skipTables`, mirroring `durableManagedTables()` / `telescopeManagedTables()` in the sibling
  `@dudousxd/nestjs-durable` / `-telescope` ecosystem.

### Patch Changes

- Updated dependencies [[`abb32bc`](https://github.com/DavideCarvalho/nestjs-agent/commit/abb32bc0396c65a59ee2b92a1a8b07d772215e31)]:
  - @dudousxd/nestjs-agent-core@0.4.0

## 0.4.4

### Patch Changes

- [`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46) - Carry image/PDF attachments through a chat turn so a vision-capable model sees them natively. A new
  `MessageAttachment` (`{ mediaId, url, contentType, name }`) rides an optional `attachments` field on
  `AgentRunInput`, `AppendMessageInput`, `StoredMessage`, and `ModelMessage`: the chat controller and
  `AgentService` accept it, the loop persists it on the user message and replays it, the MikroORM store
  round-trips it as a JSON column on `agent_message` (auto-added by the additive schema heal — no
  migration), and the AI-SDK adapter renders a user message with attachments as native `image`/`file`
  content parts (`image/*` → image, else file — Bedrock Claude reads a PDF this way). The React
  transport forwards per-send attachments via the request body
  (`sendMessage({ text }, { body: { attachments } })`).

  All fields are optional, so text-only consumers are unaffected. The lib stays provider-agnostic: it
  passes the attachment `url` straight through as the part's source — making that URL reachable by the
  provider (presigned S3, a proxy) is the consumer's concern; the lib never fetches bytes or talks to a
  store.

- Updated dependencies [[`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46), [`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46), [`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46)]:
  - @dudousxd/nestjs-agent-core@0.3.3

## 0.4.3

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

## 0.4.2

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
