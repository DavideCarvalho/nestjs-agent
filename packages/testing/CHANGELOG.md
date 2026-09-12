# @dudousxd/nestjs-agent-testing

## 0.11.0

### Minor Changes

- [#101](https://github.com/DavideCarvalho/nestjs-agent/pull/101) [`a60bd23`](https://github.com/DavideCarvalho/nestjs-agent/commit/a60bd2359bcdfa51c22fea60034635a0a5b3af41) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Ship a `MemoryProvider` you can actually run: `InMemoryMemoryProvider`, plus the fixtures an adapter
  is held to.

  Memory has shipped an SPI, a `remember` tool and a `memory:digest` checkpoint, and no storage — so
  every deployment that wanted the feature wrote a provider first, including the specs. There was no
  implementation of the interface anywhere in this repository, which meant the rules the SPI's own
  documentation states were prose rather than something executable.

  `InMemoryMemoryProvider` is the whole interface:

  - `list` returns only records at the scopes it was given. The gate is in the LOOKUP, not after it:
    the library drops out-of-scope records it is handed, but that is a backstop, and an adapter that
    leans on it has made privacy a property of its caller.
  - `write` upserts on (`scope`, `key`) and carries `pinned` across the rewrite. An upsert that reset
    the flag would silently unpin a record the next time the agent restated the same key.
  - `write` refuses an agent-authored record at any scope but the actor's own — the storage half of
    `memoryWriteVerdict`'s third rule. A human-authored one at a wider scope is allowed, because that
    is what a host console publishing an organisation's policy does, and whether that person may write
    there is a question `memoryWriteVerdict` answers with facts a provider is not handed.
  - `forget` deletes only from the actor's own scope, so an id alone cannot reach a tenant's or the
    deployment's memory. A missing id and somebody else's id answer identically.
  - `pin({ id, pinned })` is the operator act the SPI has no method for, on purpose: a pin grants a
    fact a permanent place in every future prompt, so nothing an agent can reach may set it.

  `{ recall: true }` also serves `search`, ranked by word overlap. Word overlap is not a relevance
  model; it is deterministic, and it exercises the path a host with an index takes — including the
  clause that is easy to miss, where every record sharing a ranked key has to travel or the block
  renders an organisation's value as the actor's own. Without the option there is no `search` property
  at all, which is the switch `offerMemories` reads.

  `everyMemoryField(ctx)` and `expectedMemoryRecord(...)` are the round-trip fixtures, typed
  `Required<StoreMemoryInput>` and `Required<MemoryRecord>` the way `EVERY_MESSAGE_FIELD` and
  `everyRunStartField` are. A field added to either shape fails to **compile** in the fixture until it
  is filled in, which is earlier than any assertion — an origin field an adapter silently drops is
  invisible to a test that asserts only on the fields someone remembered.

### Patch Changes

- [#101](https://github.com/DavideCarvalho/nestjs-agent/pull/101) [`a60bd23`](https://github.com/DavideCarvalho/nestjs-agent/commit/a60bd2359bcdfa51c22fea60034635a0a5b3af41) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `InMemoryMemoryProvider` holds two parts of the `MemoryProvider` contract it was stating but not
  keeping. Both matter more here than in any other adapter: this is the shape a host copies when it
  writes its own provider, so a divergence between the reference and the SQL adapters teaches the wrong
  contract.

  - `search` now returns records **most-relevant-first**, as `MemoryProvider.search` requires. The
    relevance ranking was computed and then dropped, and the results came back in whatever order the
    map happened to hold them. That is not cosmetic: `resolveMemoryDigest` selects by a record's
    POSITION under `ranked` rather than by scope, so a provider returning the right set in the wrong
    order hands the prompt ceiling a relevance judgement nobody made — and silently keeps the wrong
    memories when there are more matches than `maxMemories`. Records sharing a key stay adjacent, and a
    pinned record whose key ranked nothing sorts last, because the digest lifts pinned entries ahead of
    the ceiling anyway and placing one among the ranked would cost a slot the query did ask for.
  - The store and its callers no longer share objects. `write` filed the caller's `origin` by reference
    and returned the very record it had stored, and `list`/`all` handed out the live map values — so a
    consumer mutating anything it read, or mutating an input after the write returned, silently
    rewrote the store. Every value crossing the boundary is now a copy, `origin` included, which is
    what a SQL adapter gets for free by mapping rows.

  The specs that pin these are the discriminating kind: an order-sensitive assertion over more than one
  result, and a mutate-then-re-read for each of the four ways a caller can reach a stored object.

## 0.10.0

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

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Persist a message's `attachments` in the Drizzle and in-memory stores.

  `AppendMessageInput` has carried `attachments` all along and the MikroORM adapter persisted them,
  but the Drizzle adapter had no such column — not in its `schema.ts`, not in its DDL — and neither it
  nor the in-memory store wrote the field. So the same conversation round-tripped differently
  depending on which adapter the host had wired: a user attached a PDF, reopened the thread, and it
  was gone, with nothing logged. `ensureAgentSchema` adds the column to a table that predates it.

  A round-trip test now asserts that every field `appendMessage` accepts comes back out of
  `getThread`, which is the check whose absence let a whole field go unwritten.

## 0.9.0

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

## 0.8.1

### Patch Changes

- Updated dependencies [[`70114eb`](https://github.com/DavideCarvalho/nestjs-agent/commit/70114ebb9a7a3702d2efdb11e0dea6956a7ba8db)]:
  - @dudousxd/nestjs-agent-core@0.10.0

## 0.8.0

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

## 0.7.0

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

## 0.6.1

### Patch Changes

- Updated dependencies [[`6263338`](https://github.com/DavideCarvalho/nestjs-agent/commit/6263338cf86df7b51cb082d5d2d575987cd13383)]:
  - @dudousxd/nestjs-agent-core@0.7.0

## 0.6.0

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

## 0.5.0

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

## 0.4.0

### Minor Changes

- [#3](https://github.com/DavideCarvalho/nestjs-agent/pull/3) [`abb32bc`](https://github.com/DavideCarvalho/nestjs-agent/commit/abb32bc0396c65a59ee2b92a1a8b07d772215e31) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `AgentModule.forRoot()`/`forRootAsync()` gain a `guards` option (`Type<CanActivate>[]`), stamped
  uniformly on every mounted controller (chat, threads, tool-call, quota, agents, and attachments) via
  `@nestjs/common`'s own `@UseGuards` metadata key with REPLACE semantics — a repeated module
  registration never accumulates guards onto the shared controller classes. Guard classes are added to
  the module's `providers` for DI.

  Tool-related `AgentStreamEvent` frames (`tool-input-start`, `tool-input-available`) now carry an
  additive `toolKind: 'read' | 'action'` (collapsing the `agent` delegation kind into `read`, since
  that's the distinction a client actually needs — approval-gated or not), stamped from the tool
  registry so a UI no longer has to hardcode a tool-name allowlist to know which calls need approval.
  Persisted tool calls (`StoredMessage.toolCalls[].kind`) carry the full `ToolKind` (`read | action |
agent`) for the same reason on the thread-read side.

  Per-step/message token usage now prices into `costUsd: number | null` — on the `step-finish` stream
  frame and the persisted assistant message's `usage` — via the optionally-bound `AGENT_PRICING_STORE`
  (a provider-reported cost wins when the model turn reports one). The price list is fetched once per
  run and reused for every step, not re-fetched per message. `null` (never a fabricated `0`) when no
  pricing store is bound or the model has no price row.

  `AgentStore` gains two OPTIONAL SPI methods so existing stores keep compiling: `updateThread(threadId,
{ title?, defaultAgent? })` and `activeRunForThread(threadId)`. Thread read/list payloads add
  `defaultAgent: string | null` and `activeRunId: string | null` (`null` when the bound store doesn't
  implement the corresponding method). `PATCH /agent/threads/:id` now accepts `{ title?, defaultAgent?
}` (title-only patches still work against any store via the required `setTitle`; a `defaultAgent`
  change 501s with a clear message against a store that lacks `updateThread`). `chat()` without an
  explicit `agentName` on a thread whose `defaultAgent` is set now uses it — explicit `agentName` still
  wins, the module's configured default is the final fallback. `@dudousxd/nestjs-agent-testing`'s
  `InMemoryAgentStore` implements both new methods (the latter by reading the same `activeStreamId`
  field `setActiveStream` already maintains, now correctly cleared to `null` when a run finishes or
  fails instead of staying stamped forever).

  New core SPIs, both optional and unbound by default: `ActorDirectory` (`AGENT_ACTOR_DIRECTORY`) —
  resolves opaque store `actorRef`s to display labels for governance/dashboard read surfaces — and
  `AttachmentStagingStore` (`AGENT_ATTACHMENT_STAGING`) — persists an uploaded file and returns the
  `MessageAttachment` to send with the next chat message. When the latter is bound and
  `AgentModuleOptions.attachments.upload` is `true` (a static flag — controllers are build-time; DI is
  run-time), `POST /agent/attachments` mounts (multipart, single `file` field, buffered in memory,
  validated against a configurable size cap / content-type allowlist) under the same path prefix and
  guards as the other controllers. `upload: true` with nothing bound to `AGENT_ATTACHMENT_STAGING` fails
  boot loudly instead of mounting a controller that would 501 on every request.

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
