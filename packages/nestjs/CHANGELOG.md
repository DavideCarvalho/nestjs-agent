# @dudousxd/nestjs-agent

## 0.13.0

### Minor Changes

- [#88](https://github.com/DavideCarvalho/nestjs-agent/pull/88) [`ad383f8`](https://github.com/DavideCarvalho/nestjs-agent/commit/ad383f823e0da2ac208c5cfb737eebb6046f4cf2) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Dispatching a turn off its pod is now something a deployment says, not something it inherits.

  `dispatchedSteps` decides where the turn's model call and its tool executions run: inside the
  `agent.run` workflow body, or inside whichever worker serves the `AgentRunSteps.llm`/`.tool` groups.
  It defaulted to ON under `durable: true`. It now defaults to OFF, and `dispatchedSteps: true` is the
  only way to route those two steps.

  **Why it cannot be a default.** The flag relocates the HOST's own code. A `@AiTool` handler stops
  running in the turn's workflow body and starts running in a step worker — and the `llm` step re-runs
  the host's tool-visibility callbacks there too, to rebuild its tool list. A handler that resolves
  anything per invocation from the context its caller was in finds nothing in that worker: a
  request-scoped ORM EntityManager, an AsyncLocalStorage tenant, a CLS transaction. Nothing in this
  library can tell whether a given host's tools do that, so nothing in this library should be picking
  the answer.

  The worst case is an `action` tool, because HITL is built on the promise that approving one runs it.
  A relocated handler that cannot resolve its context throws, the loop records the call `failed` and
  hands the error to the model as a tool result, and the turn completes — so a human's approval is
  spent, the action never happens, and the audit row reads like the tool's own bug.

  **Upgrading.** A host that named no `dispatchedSteps` gets the in-process path, which is the path
  this library has actually been running: the flag was inert until 0.12.0, because
  `AgentRunWorkflow`'s `AgentRunSteps` parameter was typed as a union and so had no resolvable
  `design:paramtypes` token to inject. Set `dispatchedSteps: true` to route the two long steps, once
  the tools this deployment registers establish whatever context they need themselves (`@Step`-style:
  MikroORM's `@CreateRequestContext()`, an explicit `fork()`, your own ALS entry) and a cross-process
  `TokenStreamSink` is wired.

  A run already in flight is unaffected either way: the branch is gated on
  `ctx.patched('agent:dispatched-steps')`, so a parked turn finishes on the shape its journal holds.

  Behaviour is identical on both paths for a tool that needs nothing from its caller, which is why no
  test noticed the flag was inert and none would have noticed it turning on. The durable suite now
  asserts the journal a `durable: true` host gets when it says nothing — `llm:0` and
  `tool:<callId>`, across a full HITL park-and-approve — so where a host's tools execute is a fact a
  test holds rather than a default's side effect.

## 0.12.0

### Minor Changes

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - A delegation cycle is now detected as a cycle, not guessed at from depth.

  The loop only ever received a delegation COUNT, so a count was all it could reason about. That
  conflates two different faults. A mutual handoff (A→B→A→B…) ran five agent turns before anything
  stopped it and then reported `delegation depth limit of 5 reached`, which leaves the reader to work
  out whether their chain was looping or merely long — the one question a count cannot answer. And a
  legitimate chain of six DISTINCT agents was refused for resembling a cycle it was not.

  The chain of agent names costs exactly what the counter cost to thread. `AgentRunInput.delegationPath`
  carries it, both runners append their own agent for each child they start, and the loop compares the
  delegation target against its own ancestry. A repeat IS the cycle:

      (delegation cycle: alpha → beta → alpha — alpha 2 times on one chain)

  `AgentLoopDeps.maxAgentAppearances` / `@Agent({ maxAgentAppearances })` defaults to **1**. It counts
  APPEARANCES, so `2` admits exactly one deliberate return to an earlier agent. The depth ceiling stays
  as the backstop for a chain that is long without repeating, and is reported only when nothing is
  circular.

  **Upgrading.** Nothing to configure. A runner that threads no chain — a custom one — reads an empty
  ancestry, finds no repeat, and falls back to the depth ceiling exactly as before. Both bundled
  runners thread it.

  **Behaviour that changes.** A chain that revisits an agent is now cut at the first repeat instead of
  at depth 5. If you depended on an agent being delegated to twice on one chain, set
  `maxAgentAppearances`. Note this is strictly earlier, not stricter in the end: such a chain was
  already being cut, just four agent runs later and under a message that named the wrong reason.

  Also: the `Required<AgentOptions>` gate added alongside the depth ceiling caught its own author
  forgetting to surface `maxAgentAppearances` on the decorator, within the hour. It only bites under
  `typecheck:specs`, which `@dudousxd/nestjs-agent` does not yet run.

  **Known limit, unchanged by this.** `@Agent({ handoff })` cannot express A↔B directly, because a
  class cannot name a class declared after it. Mutual edges arrive through circular imports between
  agent modules, which is the shape this guard is for.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Start a sub-agent and keep talking.

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

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - `SkillProvider` takes named parameters.

  `load(name, scope, ctx)` put two adjacent `string` arguments in a published signature. Transposed,
  that call compiles without a complaint, returns `null`, and the skill silently fails to load — the
  failure category this release has spent its time removing. `list(scopes, ctx)` follows for
  consistency and because an object parameter can gain a field later without a breaking change.

  ```ts
  list({ scopes, ctx }); // was: list(scopes, ctx)
  load({ name, scope, ctx }); // was: load(name, scope, ctx)
  ```

  `ListSkillsInput` and `LoadSkillInput` are exported. A single-argument method keeps its positional
  form — `body(ctx)` is unchanged, because wrapping one well-named argument buys no safety.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Skills: an authored procedure the model pulls in when a task calls for it.

  The instructions a deployment needs the agent to follow had two homes, and both were wrong for most
  of them. In the system prompt they are paid for on every turn, by every user, whether or not the work
  calls for them — and an agent with a per-base ingestion quirk, a work-order rule and a normalisation
  procedure is an agent whose prompt is mostly things the current question does not need. Hardcoded as
  a tool, the instructions are a deploy away from changing and the model has to guess from a name what
  the tool will tell it.

  A skill splits the two halves. The turn's system block carries a CATALOG — one line per skill: its
  name, the scope it came from, and what task it covers. The body is read on demand, through a built-in
  `skill` tool, and arrives as an ordinary tool result. So an instruction costs a prompt line until the
  turn that needs it, and costs nothing at all on the turns that do not.

  **A skill is not an agent.** An `@Agent` is who is answering — its model, its tools, its history
  ceiling, its output schema. A `@Skill` carries none of those: it is a name, a description, a scope
  and text, and any agent may load it. An instruction that should apply to every turn of a persona is
  still that persona's `systemPrompt` or a `@SystemPromptContributor()` — a skill is for the ones that
  should apply only when the work calls for them, which is the whole of what makes them cheap.

  **Scoping is an opaque token, resolved by the host.** A skill is published at a token —
  `actor:u1`, `tenant:base-7`, `global`, or a deployment's own `sector:logistics` — and which tokens
  apply to a turn is answered by a `ScopeResolver` returning them MOST SPECIFIC FIRST. Precedence falls
  out of that order, so a new axis (a sector, a squadron, a shift) is a resolver a host writes rather
  than an enum or a column in this library. `defaultScopeResolver` covers what an `Actor` alone can
  say — the actor's own scope, their tenant's, and the deployment's — so the common case wires no host
  code at all.

  **This library owns no skill table, and adds no column to either store adapter.** The rows are the
  host's, behind a `SkillProvider` with two calls: `list(scopes, ctx)` for the catalog, on every turn,
  and `load(name, scope, ctx)` for one body, only when the model asks. A consumer that needs an admin
  UI over "every skill for sector X" joins its own `Sector` entity against the token values in its own
  read model — without writing migrations into a schema this package's boot-time heal also edits.
  Skills that are authored rather than administered are `@Skill`-decorated providers, discovered at
  boot, with a flat `body` string or a `body(ctx)` method that gets DI.

  **Conflict is reported, not resolved silently.** The most specific scope wins, and the scopes it
  outranked are recorded on the entry's `shadows` — shown to the model in the catalog block and
  returned on the endpoint — so the agent can say "I followed your base's version, which differs from
  the org default" rather than quietly choosing.

  **`GET /agent/skills`** lists what THIS actor can reach right now, scope-resolved, as
  `{ name, description, scope, shadows? }[]` — the same list the model is offered, built by the same
  `offerSkills` call against the same provider and resolver, so a `/`-autocomplete can never offer a
  skill the agent has never heard of. Ownership posture mirrors `GET /agent/agents`: the actor comes
  from the resolver, and nothing a caller passes widens the answer.

  **Write authority.** There is no HTTP write surface: who administers `sector:logistics` is a fact
  this library does not have. What it ships is the rule, as a pure `skillWriteVerdict` a host calls
  from its own console — you may only write into a scope you are in; your own scope is yours; a wider
  one needs the host to say the human is elevated; and **nothing but a human may ever write above its
  own scope**, whatever elevation a host would grant. An agent that can write a `tenant:` skill is an
  agent whose prompt anyone in that tenant can edit by talking to it, and no amount of permission makes
  that a different shape.

  **Checkpoints.** One new position, `skills:catalog`, holding the WHOLE offer — the scopes the
  resolver returned and the entries that survived precedence — and reachable only through new config,
  so no in-flight run can land on it. A `skill` call spends a plain read tool's positions and adds no
  name of its own (`persist:toolcall:<id>`, `tool:<id>`, `persist:toolexec:<id>`). Both payloads are
  load-bearing rather than incidental: which instructions entered a turn's prompt is a decision about
  that turn, so it has to be readable from its journal. A replay re-reading the provider would compose
  a different prompt from a skill edited in between, on a transcript position the history already
  holds. `ToolKind` gains a fifth member, `'skill'`, carried by no `ToolSpec` — the tool is never
  registered, and its branch is settled inside the already-journaled `persist:toolcall` checkpoint, the
  same way `action` and `ask` are. Configure no skills and a turn's checkpoint sequence is
  byte-identical to one that never had the option.

  **Budget.** Five things now write the system block — the agent's base prompt, its
  `@SystemPromptContributor()` sections, memory, injected retrieval, and this catalog — assembled in
  that fixed order. Skills are deliberately the cheapest: the catalog is one line each, capped by `maxSkills`
  (default 20, widest scopes dropped first), and the bodies ride the TRANSCRIPT, where the
  `HistoryPolicy` ceiling already governs them. A new `aviary:agent:skills.resolved` diagnostics event
  reports how many were offered, how many the cap left out, and exactly how many characters the block
  added — so a turn whose input tokens jump can be attributed to a contributor by name rather than
  guessed at.

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

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Constrain a turn's answer to a schema.

  Every answer this library produced was free text, so the only way to get a typed value back out of a
  turn was to declare a TOOL whose whole job was to receive it — which is how the main consumer ended
  up with a `renderResult` tool that renders nothing and exists purely to smuggle structure past the
  prose.

  `@Agent({ outputSchema })` takes any [Standard Schema](https://standardschema.dev) (Zod, Valibot,
  ArkType). The validated value comes back as `object` on the run's result, typed when the loop is
  called directly (`runAgentLoop<T>`), and is recorded on the assistant message as a synthetic
  `structured_output` tool call — the device inject-mode retrieval already uses, so it reaches every
  thread reader and the UI's existing tool-output rendering without a store gaining a column. It is
  declared on the agent rather than per request because a schema is a live object and `AgentRunInput`
  crosses a JSON boundary on its way into a durable workflow.

  **How it composes with tool calling: as a separate formatting pass, always.** The turn runs its
  model→tools iteration exactly as it would without a schema; once a step comes back with no tool
  calls, one extra non-streamed call (`structured:<step>:<n>`, `tools: []`, `outputSchema` set)
  restates that answer as the schema. Most providers cannot serve a response format and a tool set in
  the same request. Skipping the pass for an agent that happens to have no tools would be cheaper and
  is deliberately not done: that decision would read the tool registry of whichever process is
  replaying, which is how a resumed run ends up asking for a checkpoint position its history has no
  room for. So the pass is unconditional, and it costs one model call per turn, billed as its own
  `structured_output` usage row.

  The pass restates the answer that survived the output gate, never the model's raw reply, and is told
  to use only what the conversation already contains — the structured value is a translation of the
  answer, not a second route out of the model.

  **An answer that fails the schema is a defined outcome.** Up to `outputRepairAttempts` further calls
  (default 1) re-ask with the previous attempt's validation issues attached; after that the run fails
  with a `StructuredOutputError` carrying the issues, the text that failed them, and the attempt count,
  under its own `structured_output_invalid` stream error code. Bounded because a model that cannot
  satisfy a schema usually cannot satisfy it on the fourth try either, and every attempt is billed. Set
  `outputRepairAttempts: 0` to fail on the first invalid reply.

  `ModelTurnArgs` gains `outputSchema` and `ModelTurnResult` gains `object`. The AI SDK adapter maps
  the schema onto `streamText`'s `output: Output.object(...)` so the provider constrains generation,
  and passes its parsed value back — but the loop validates it regardless. "The provider says it
  matched" is not the same claim as "it matches", and a provider that ignored the schema has to fail
  where the failure is repairable rather than downstream. An adapter that cannot constrain generation
  at all still works: the loop reads the JSON out of the reply text, fences and lead-in prose included.

  `UsagePurpose` gains `'structured_output'`. Both shipped stores persist `purpose` as text, so no
  schema change is needed. A consumer who declares no `outputSchema` sees no new checkpoint, no extra
  call, and no change to the loop's checkpoint sequence.

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

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Stop taking attachment URLs, live-stream access and human replies from the request body.

  Four fixes from a security review of the HTTP surface. The first two are **breaking** — deliberately,
  because the compatible version of either is "keep trusting the client".

  **1. `POST /agent/chat` no longer accepts a url (SSRF).** `attachments` was typed
  `MessageAttachment[]` and passed through verbatim, so the caller chose the url the model provider
  fetches at turn time. Any authenticated user of an app on this library could make the server fetch
  `http://169.254.169.254/latest/meta-data/iam/security-credentials/` — or any internal address it can
  reach — and read the response back out of the model's answer. It also bypassed the upload route's
  content-type allowlist and size cap, being a different route.

  A chat turn may now only name a `mediaId`; every other field sent with it is discarded.
  `AttachmentStagingStore` gains **`resolve({ mediaId, actor })`**, which returns the
  `MessageAttachment` to send or `null` when the id is unknown _or_ is not that actor's (the two are
  indistinguishable on purpose, so the endpoint can't be used to probe media ids). The url the model
  fetches now only ever comes from the host's own store, and is resolved per turn — which also fixes
  the stale-presigned-url problem a durable run that replayed past a url's TTL used to have.

  _You are exposed if_ your app sends `attachments` on a chat turn. _To upgrade:_ implement `resolve`
  on your `AttachmentStagingStore` (TypeScript will tell you — it is a required method) and make sure
  it checks ownership; it is the ONLY thing standing between a caller and an arbitrary server-side
  fetch. Clients need no change as long as each attachment carries its `mediaId` — which the object
  returned by `POST /agent/attachments` and `AgentClient.uploadAttachment` already does. **With no
  `AGENT_ATTACHMENT_STAGING` bound there is no way to tell an actor's own media from anyone else's, so
  a turn carrying attachments is refused with `501` rather than trusted.** A text-only turn is
  unaffected. A turn may name at most 10 attachments.

  **2. `GET /agent/chat/:runId/stream` is ownership-scoped.** It resolved no actor and checked
  nothing: anyone past the module's own guards holding a `runId` read another actor's live turn — the
  answer, tool arguments, tool results, and the RAG passages and structured output that ride as
  synthetic tool calls. A `runId` is a UUID, but it is handed out in the `X-Agent-Run-Id` header, the
  SSE `meta` frame, Telescope, the durable dashboard and the logs. It now resolves the actor and
  checks the run the way `POST /agent/chat/:runId/cancel` already did: `403` for another actor's run,
  `404` for a run nobody is streaming. **A run that has already finished is now a `404` instead of a
  buffer replay** — ownership is derived from the thread's active stream, which the runner clears as
  the run ends. `AgentService.subscribeAs(actor, runId)` is the gated call; `subscribe(runId)` stays
  ungated for in-process callers that are authorized upstream, the same split
  `approve` / `signalToolCall` already uses.

  **3. `POST /agent/tool-call/*` validates its body.** `answers` was typed `Record<string, string[]>`
  and checked nowhere, so `{"answers":{"q1":"oops"}}` reached the elicitation resolver and threw on
  `.filter` of a string. The signal payload is journaled, so _every replay reproduced the crash_ — one
  malformed request killed a run permanently and burned its durable retries. Shape and size are now
  checked before anything is signalled (at most 100 questions, 100 values each, 4096 characters per
  value), as is `reject`'s `reason` (a string, at most 4096 characters — it reaches the model as a
  tool result) and every route's `toolCallId`. Well-formed requests, including an empty `answers`,
  behave exactly as before.

  **4. `POST /agent/attachments` bounds the upload before buffering it.** `FileInterceptor` ran with
  no `limits`, so the entire body was read into memory and only then measured against
  `attachments.maxBytes` — one request could OOM the pod. Multer now aborts mid-stream at
  `HARD_MAX_ATTACHMENT_BYTES` (32 MiB), with the configured cap still applying as the second
  gate. `attachments.maxBytes` narrows that ceiling and cannot raise it: a host that set it above 32
  MiB now gets `413` at the ceiling.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add a `HistoryPolicy` seam so a turn no longer carries the entire thread.

  The loop mapped every message `getThread` returned into the model's messages, with no window, no
  budget and no summarization. A long-lived thread therefore grew until the provider rejected the
  request outright, and every turn before that one paid for the whole transcript — the lib priced that
  spend and enforced a quota against it, but nothing bounded what generated it.

  `AgentModule.forRoot({ history: { maxMessages, maxTokens } })` keeps the newest messages that fit,
  and `@Agent({ history })` lets one persona set a tighter ceiling than the module's. Adding
  `summarize: true` folds what the window left out into a leading `system` summary, produced by one
  extra model call and recorded as a `history_summary` usage row so bounding context cost cannot
  itself become spend nothing accounts for. `historyPolicy` takes a `HistoryPolicy` of your own for a
  window the built-in cannot express; `windowHistory`, `summarizeWithModel` and `estimateMessageTokens`
  are exported for composing one.

  Nothing changes for a consumer who configures none of this: the turn still carries the whole thread,
  and the loop's checkpoint names and positions are byte-identical, so a run already in flight keeps
  replaying. Selection is deliberately a pure function called OUTSIDE any checkpoint — that is what
  lets a policy exist without moving a position — and summarization, which calls a model, runs inside a
  `history:summarize` checkpoint so a resumed run reads back the summary the suspended attempt
  produced rather than prompting with a different one.

  `UsagePurpose` gains `'history_summary'`. Both shipped stores persist `purpose` as text, so no
  schema change is needed; widen your own store's column if it constrains the value.

  Detect durable control-flow signals in core instead of relying on the host to.

  `AgentLoopHooks.isControlFlowError` is optional, so a host that omitted it had every durable suspend
  swallowed by the tool try/catch and written to the journal as a tool failure — a run that should have
  resumed on approval instead came back as a failed call, and the replay it left behind could not line
  up. The loop and `invokeWithTransientRetry` now recognize the `Symbol.for('aviary:durable:control-flow')`
  marker the durable runtimes stamp on their signals, checked as a property so it works across the two
  packages that raise them and across duplicate module copies. Core gains no dependency on either
  durable package. The hook remains, as an override for a runner whose signals carry no marker.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Dispatched steps now actually dispatch.

  `AgentRunWorkflow` took `AgentRunSteps` as `@Optional() private readonly steps: AgentRunSteps |
undefined`. That is a union type, so TypeScript emits `Object` as its `design:paramtypes` entry, and
  with no explicit `@Inject` token Nest had nothing resolvable to look up — `@Optional()` turned that
  into `undefined` rather than an error. The class constructed fine, `AGENT_DISPATCHED_STEPS` read
  `true`, and the workflow silently took the in-process fallback on every surface. No turn has ever
  left its pod for the model call or a tool execution, whatever `dispatchedSteps` was set to. Existing
  tests asserted behaviour, which is identical either way, so nothing caught it.

  The dispatch decision no longer reads that instance at all. `ctx.step` routes by the `@Step`-stamped
  name and never invokes the reference — the serving worker re-resolves the handler from its own DI —
  so the names are read off `AgentRunSteps.prototype` and a pod that provides no `AgentRunSteps` (the
  `'http'` surface, which registers the workflow only so `start()` can enqueue it) replays the same
  branch instead of degrading to the in-process one and diverging from the history an engine pod
  wrote. The constructor parameter is gone.

  Which branch a turn takes changes the checkpoint names it writes, so it is gated on `ctx.patched`: a
  fresh run dispatches, a run already journaled under the in-process names finishes on them. Upgrading
  therefore does not strand in-flight turns.

  **This changes deployed behaviour.** A multi-pod deployment will, for the first time, execute
  `AgentRunSteps.llm`/`.tool` on whichever worker serves those groups. Confirm the groups are served
  and that a cross-process `TokenStreamSink` is wired (the default in-process sink cannot stream a
  turn whose model call ran elsewhere) before upgrading, or set `dispatchedSteps: false`.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add input and output processors — a seam on each side of the model call.

  `PromptContributor` could append to the system prompt and nothing at all could look at the answer.
  For an application that runs generated SQL over sensitive data that is a gap in the controls, not a
  missing convenience: the one place where the model's output can still be stopped is between the
  provider and the reader, and there was no such place.

  `AgentModule.forRoot({ inputProcessors, outputProcessors })` (or `AgentLoopDeps` directly) adds both.
  An `InputProcessor` rewrites `{ system, messages }` before every model call of a turn — every call,
  not once per run, because the transcript grows between steps and a redactor that only saw the opening
  prompt would wave through whatever a tool result carried back. An `OutputProcessor` sees each step's
  answer and returns `pass`, `replace` (a redaction is a replacement), or `reject`, which ends the run
  with an `OutputRejectedError` and an `output_rejected` stream error rather than an answer. Processors
  are module-wide and apply to every agent: a control one persona can opt out of is not a control.

  **They are not a second `HistoryPolicy`.** Selection — which of the thread's messages ride into the
  turn — stays with `history`/`historyPolicy`, which is pure and runs outside any checkpoint.
  Processors transform what selection produced, and run inside one, so they may call a model. The
  loop's canonical transcript is untouched by them: a redaction is what leaves the process, never the
  thread's own memory of what was said.

  **Registering an output processor turns off live token streaming for the turn, and that is the
  honest trade.** A gate that must read the whole answer cannot run after the answer has already
  reached the reader. So the turn's model call writes to a buffer instead of the sink, and the loop
  releases it — as one `text` frame — only once the chain has passed. The subscriber still gets step
  boundaries and the turn's tool-call frames live; what it loses is token-by-token text, plus any
  frame the gate cannot classify (a provider writing bare bytes rather than the `AgentStreamEvent`
  vocabulary gets its text reconstructed from the gated answer, because forwarding bytes it cannot
  read would not be a gate). Configure no output processor and the turn streams exactly as it always
  did.

  The buffer rides the `llm:<step>` CHECKPOINT rather than a local variable, and the release happens
  inside the same `process:output:<step>` checkpoint that carries the verdict. Both matter under
  durable replay: a run that suspends between the model call and the gate resumes in a process that
  never saw the model's stream, and a release outside the verdict's checkpoint would flush the same
  answer again on every replay. Under `dispatchedSteps: true` — the production default — the model
  runs on another worker entirely, so `LlmStepEnvelope` carries a `bufferOutput` flag and
  `AgentRunSteps.llm` hands the held frames back on its result. Without that, the gate would have been
  bypassed on precisely the deployment that needs it.

  A processor that throws surfaces as `ProcessorFailedError` naming the phase and the processor, so it
  can never be read as the model call failing. A refused turn still records its `chat` usage row before
  it fails: those tokens were genuinely spent, and a gate that hid its own cost could burn a budget
  invisibly.

  Nothing changes for a consumer who registers neither: the loop's checkpoint names and positions are
  byte-identical, so a run already in flight keeps replaying.

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

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Make `cancel` cancel.

  `POST /agent/chat/:runId/cancel` answered `{ aborted: true }` and the run carried on to completion,
  tool calls included. The durable runner's `cancel` was `await Promise.resolve()`; the inline one only
  ended the sink, so the stream went quiet while the loop kept spending. A Stop control now ships in
  the React package on top of that, which turns a missing feature into a button that says "Stopping…"
  and stops nothing — worse than not having it.

  **The loop observes a cancel and unwinds.** `AgentLoopHooks.cancelled()` is asked at the points where
  stopping is safe and cheap — between steps, before the next model call, and before a turn's tool
  calls are dispatched — and a set flag throws `RunCancelledError`, which unwinds through the same path
  a durable suspend already uses.

  **A tool already executing is not interrupted, and that is the design rather than a gap.** There is
  no un-executing a side effect, and abandoning a dispatched step mid-flight would leave the journal
  holding a dispatch whose result never lands. A tool that has started runs to completion and is
  recorded exactly as it would have been; the cancel is taken at the next point. So a cancel landing
  mid-tool costs that one tool, and nothing after it.

  **The observation is journaled, because the loop body is replayed.** `hooks.cancelled()` is only ever
  called from inside a `hooks.step` checkpoint, so the first process to reach a position writes the
  answer there and every replay reads it back. A cancel arriving between two replays is therefore seen
  at the first position the history does not yet hold, and cannot change the branch a replayed position
  already took. The positions themselves sit behind `hooks.patched('agent:cancellation')`, so a run in
  flight when this ships keeps replaying against the sequence it recorded; a runner that wires no hook
  adds no checkpoint at all.

  **A cancelled run is distinguishable from a failed one and from a completed one.** `RecordRunEndInput.status`
  gains `'cancelled'` — a third terminal, with no `errorCode`/`errorMessage`, so a consumer's failure
  rate can leave a user pressing Stop out of it. On the wire, `AgentStreamEvent` gains `{ kind: 'cancelled' }`,
  written as the stream's last frame before a normal `end()` — never a `fail()`, so a client that
  retries a failed stream does not retry a deliberate stop, and a reader can tell a truncated answer
  from a complete one. `agentFailureCode` answers `'cancelled'` rather than `'run_failed'`.

  **Per runner.** The inline runner holds the request in-process and additionally REJECTS any wait
  parked on a human, so a turn sitting on an approval stops immediately instead of waiting forever. The
  durable runner calls the runtime's own cancel in its compensating form through `RUN_GATEWAY` (bound
  under both durable topologies, unlike `WorkflowEngine`): that moves the run to `cancelling` — which is
  what the workflow's cancel observation reads — and re-drives it, so an in-process turn unwinds at its
  next safe point, child runs cascade, and a turn parked on `waitForSignal` still settles `cancelled`.
  That last case is the one thing no in-body observation can reach: it is suspended inside a checkpoint
  its journal already holds, so nothing new is ever evaluated there.

  The runner settles the run row and the subscriber's stream (both keyed by run id alone); the run body
  releases the thread's `activeStreamId`, because only it knows which thread the run was streaming.

  Unknown stream frames are already ignored by the bundled transport, so a client that has not learned
  `cancelled` sees the `end()` it always saw.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Let an output processor declare that it can gate a prefix, so the turn keeps streaming.

  Registering any output processor turned off live token streaming for every agent. That is the right
  answer for a moderation pass that has to read the whole answer, and much too expensive for a regex
  redactor that does not: on a live demo the same turn went from 66 streamed text frames to 1. The
  module-wide SCOPE stays — a control a persona can opt out of is not a control — but the streaming
  cost was welded to it, and now it is proportional to what the processor actually needs.

  ```ts
  const redactEmails: OutputProcessor = {
    name: "redact-emails",
    incremental: { lookbackChars: 320 },
    process: (answer) => ({
      action: "replace",
      text: answer.text.replace(EMAIL, "[email]"),
    }),
  };
  ```

  **Undeclared still means whole-answer**, i.e. exactly today's behaviour, and a chain is incremental
  only when EVERY member declares it. An author who wrote `process` against the complete text is never
  downgraded because a neighbour opted in.

  Declaring `incremental` is a promise about every prefix of the answer. The chain sees the growing
  PREFIX rather than each new chunk, so it always gets well-formed text and "stable under chunking"
  becomes a claim about prefixes: outside the last `lookbackChars` characters of its own output, a
  `replace` never changes as the prefix grows. `lookbackChars` is per-processor (default 64) and the
  gate uses the widest in the chain — an author who matches longer patterns says so, instead of a
  library constant silently truncating one. A rejection promises to be decidable from a prefix; one
  that only emerges from the whole answer still fails the run, but the reader has already seen text.
  That is the cost of opting in, and it is documented rather than hidden.

  **The whole-answer pass stays authoritative** for both the stream and the store — the incremental
  release only emits its prefix early. The gate then asserts the settled answer `startsWith` what was
  already released and raises `ProcessorFailedError` if not, so stream/store agreement is structural
  rather than assumed, and a window too short for a pattern fails loudly instead of streaming the text
  it was supposed to redact.

  Determinism is unchanged. `process:output:<step>` keeps its name and position in all three modes, so
  switching a declaration never moves a checkpoint. The released prefix rides the `llm:<step>`
  checkpoint as `releasedText`, and the gate step reads WHICH release it still owes from that journaled
  value rather than from the chain configured on whichever process resumed the run — so a run that
  suspended under an incremental chain cannot flush the answer twice under a re-declared one. A refusal
  reached from a prefix rides the same checkpoint as `gateRejection` and is raised only after
  `persist:usage:<step>` and `quota:bump:<step>`: those tokens were spent, and a gate that hid its own
  cost would let a mis-tuned chain burn a budget invisibly.

  `hooks.dispatchLlm` (`dispatchedSteps: true`, the production default) falls back to full buffering.
  The handler streams into a worker-side sink the loop cannot interpose on, so there is no prefix to
  release; the envelope still asks for `bufferOutput` and the turn is held whole.

  New in `-core`: `OutputProcessor.incremental`, `IncrementalGating`,
  `DEFAULT_INCREMENTAL_LOOKBACK_CHARS`, `OutputGateMode`, `resolveOutputGateMode`,
  `resolveGateLookback`, `createIncrementalGate`, `gateTail`, and
  `BufferedModelTurnResult.releasedText` / `.gateRejection`. Register nothing, or nothing declared, and
  the emitted stream and the journal are byte-identical to before.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - The delegation nesting ceiling belongs to the host.

  `MAX_DELEGATION_DEPTH = 5` was a constant nobody could change, sitting next to a `maxSteps` that
  has always been `deps.maxSteps ?? 8`. It is now `AgentLoopDeps.maxDelegationDepth`, surfaced as
  `@Agent({ maxDelegationDepth })` and defaulting to the same 5. The refusal message reports the
  ceiling that actually applied rather than the default.

  **What this is not.** It does not cap FAN-OUT — how many agents a turn delegates to has always been
  the model's decision, one tool call per target agent, and nothing in the library limits it. What the
  ceiling bounds is a chain the model cannot see: in a `delegatesTo` cycle (A→B→A) every agent is
  making one reasonable call, and the recursion is a property of the wiring, not of any decision. That
  is why it stays a guard and not a removable knob — but why the number should be yours.

  Also gated: `@Agent` options are copied into the registered `AgentDefinition` by one hand-written
  spread per field, so an option added to the decorator and forgotten there was accepted and discarded
  with nothing to fail. A new spec builds an agent from a fixture typed `Required<AgentOptions>` and
  asserts all thirteen reach the definition — it stops compiling when an option is added, which is
  earlier than any assertion could catch it.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Memory: relevance selection, always-on facts, and a block that says whose note it is.

  The first cut of memory shipped a plain scoped read and no search, on the argument that _if the whole
  memory set fits in the prompt, a semantic search over it is a search for something the model is
  already reading_. That is true given the ceiling — and the ceiling was 20, which made the argument
  circular: it justified not retrieving by pointing at a limit that existed because nothing retrieved.
  A person accumulates preferences over months; twenty facts is an afternoon.

  **The prompt budget must be bounded. The store has no reason to be.** `MemoryDigest.omitted` already
  admitted it: at any real size the block was partial, and what survived was chosen by **scope**, not by
  relevance to the turn.

  **Choosing by scope fails quietly, and worse than the ceiling does.** A turn's candidates are the
  _union_ of every resolved scope — a few hundred of yours, several hundred of your unit's, thousands of
  your base's. Narrowest-first means that as soon as one person has twenty notes of their own, **nothing
  their organisation knows ever reaches the prompt again**. The facts that apply to the most people are
  the first dropped, and the only trace is a non-zero `omitted`. That looks exactly like the feature
  working.

  So **precedence** and **selection** are now two things:

  - Precedence resolves a _conflict_ — two memories at one `key`, narrower wins, the beaten value rides
    along as `overrides`. Scope decides this, unchanged.
  - Selection decides _which of thousands_ appear at all. That is relevance to the turn.

  **`MemoryProvider.search({ scopes, query, limit, ctx })`, optional.** Omit it and every turn is the
  plain scoped read, byte-identical to before — a deployment with twenty memories must not have to stand
  up an index, and one with two thousand uses whatever it already runs. The host owns the index for the
  same reason it owns the rows; the library owns resolution, precedence, budget and the journal. Three
  clauses: filter to `scopes` **before** ranking, rank the _keys_ and take the best `limit` (precedence
  resolves a key to one line, so keys are the block's unit), and return **every record sharing a
  returned key** — a search that returned the `global` half of a conflict and not the `actor:` half would
  render the org default as the answer, and nothing downstream can detect that. One SQL query either way.

  **Scope gates, and gates first.** A search that ranks before it filters is a cross-tenant leak wearing
  a relevance score: the nearest neighbour to _"what is our rollback policy"_ is another base's rollback
  policy. `resolveMemoryDigest` drops anything returned outside the resolved scopes — not even carried as
  a beaten value, since an `overrides` line prints it just the same — so a host's filter bug costs
  throughput rather than privacy. The drop is a backstop, not the boundary.

  **It is searched with the user's own turn text, and nothing else.** The only thing available before the
  first model call, which is where memory has to be; and already a journaled input to the run, so it
  needs no determinism machinery of its own. **What it fails at is a turn with no topic** — _"and the
  other thing?"_, _"yes"_. A rolling transcript window drifts toward whatever dominated the conversation,
  and asking the model to request a recall makes it recall-on-demand, which is what working memory
  deliberately is not. The answer is pinning.

  **`MemoryRecord.pinned` — always-on, and categorical rather than a priority number.** _"Never purge the
  app-config cache during business hours"_ is never semantically close to a question about rollbacks, so
  under pure relevance it silently stops appearing. A number would inflate (everybody picks 100, then
  something has to outrank 100), carry no reviewable meaning (no natural scale, and an admin's 100 sorts
  identically to an end user's while meaning something else), and compete with relevance, which is
  already a continuous ordering — does priority 8 beat a substantially better match, and by how much? A
  category becomes a **budget** instead: pinned entries are taken from `maxMemories` first, recall fills
  the rest, and the ceiling stays the product of two numbers an operator set. Overflow still bites, but
  is reported on its own as `MemoryDigest.pinnedOmitted` (and on `memory.resolved`) — ordinary omission is
  the budget working, a dropped always-on memory is a deployment's standing policies having stopped
  reaching any prompt. A pin belongs to the _question_, so a personal override of a pinned key is pinned
  too. **An agent cannot pin its own writes:** `StoreMemoryInput` has no such field and the `remember`
  tool no such parameter, the same enforcement-by-shape that keeps `scope` off it — an agent that could
  pin its own conclusion has granted itself a permanent place in every future prompt.

  **The block is framed by `origin.author`, in two sections.** A wide-scope memory is usually _published
  by an administrator_, not concluded by the agent — that is what the write-authority rules make
  promotion a human act for. One framing over the whole list told the model to treat an organisational
  decision as its own guess, and _"prefer what the user says now"_ handed any user an override of company
  policy by asserting the opposite. Not a jailbreak: the documented instruction. Now what a person
  **stated** is framed as an instruction, with a user contradiction to be surfaced as a conflict naming
  the note and its scope; what the agent **concluded** keeps the hedge exactly as it was. A section with
  no entries is not rendered, so an agent-written deployment reads as it always did. And a **partial**
  block now says so, because a model reading a selection as the whole set turns an absence into a claim.

  `OverriddenMemory` gains `author` for the same reason, one level down: precedence is blind to it, so an
  agent's own inference at `actor:` outranks an administrator's published policy at `global`. Precedence
  is unchanged — but the block now renders a beaten value a person wrote as _"a person stated"_ rather
  than _"instead has"_, so the model can say which of the two it is departing from.

  **Determinism.** The search runs _inside_ `memory:digest`, the checkpoint that already holds the whole
  digest. A ranking is the most re-derivable thing in this library — the index moves, a neighbour is
  written, embeddings are recomputed — so its result is what every replay reads back rather than
  something a resuming pod asks again. A run that suspends for an approval and resumes an hour later
  rebuilds the identical block. No new checkpoint position; a turn that configures no memory is still
  byte-identical to one that never had the option.

  `aviary:agent:memory.resolved` gains `pinnedOmitted` and `recalled` — the latter because "this
  deployment holds few memories" and "this turn drew twenty out of two thousand" are reported identically
  by `offered` alone. `GET /agent/memories` **never** searches: a read-back that ranked would show a
  person the slice one question happened to need and hide the rest behind having asked the right thing.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Memory: what the assistant concluded about a person, carried across turns and across threads.

  Everything the agent works out about someone dies at the end of the turn. The next conversation
  re-asks which units they report in, which fiscal year their org uses, that they were corrected about
  this last week. The two places a deployment can put that today are both wrong: the system prompt,
  which is authored by a developer and identical for everyone, or retrieval, which answers from
  documents nobody wrote about this person.

  A **memory** is a keyed fact at a scope. `{ key: 'fiscal-year', text: 'they report on the calendar
year', scope: 'actor:u1' }`. It rides the system block as one line, the model writes it through a
  built-in `remember` tool, and the person it is about can read every one of them back and delete any
  of them.

  **It is not RAG, and the difference is not cosmetic.** Retrieval answers _what do the documents say_
  and cites them; memory answers _what did I decide about you_ and has no source to go and fix. So
  every record carries an origin (which conversation, which run, written by the agent or by a person),
  the block tells the model these are its own fallible notes and to prefer what the user says now, and
  `MemoryProvider.forget` is a **required** method rather than an optional one — a deployment may
  reasonably serve memory read-only, but none may reasonably hold conclusions about someone that the
  someone cannot delete.

  **Scoping is the same opaque token skills use**, resolved by the same `ScopeResolver`, most specific
  first — `actor:u1`, `sector:logistics`, `tenant:base-7`, `global`. One resolver, so a deployment
  cannot end up with two answers to "which scopes does this actor have". And as with skills, **this
  library owns no memory table**: the rows are the host's, behind a provider with `list` / `forget` /
  optional `write`.

  **Conflict is shown with both values, which is where memory departs from a skill.** A skill's entry
  records only _which_ scope it outranked — the agent follows one procedure either way. A memory is a
  value, so the entry carries the beaten **text** too, and the block prints it underneath:

  ```text
  - [actor:u1] fiscal-year: they report on the calendar year
      ↳ [global] instead has: the fiscal year starts in October
  ```

  An agent that knew only that a wider value existed could tell the user nothing except which one it
  picked.

  **Write authority: an agent proposes, a person publishes.** `memoryWriteVerdict` carries the same
  four rules as `skillWriteVerdict`, and rule three bites harder here — nothing but a human may write
  above its own scope, whatever elevation a host grants. A tenant _skill_ an agent could publish is a
  procedure anyone in the tenant can edit by talking to the assistant; a tenant _memory_ is a fact
  everyone in the tenant is then answered from, with no document to inspect and nobody aware it was
  written. The `remember` tool enforces it by shape as well as by check: **it has no scope parameter**,
  so there is no request rule three has to refuse. Promotion to a wider scope is a human act in the
  host's own console.

  **Forgetting is part of the feature, not a console someone might build.** `GET /agent/memories`
  returns everything this actor can reach — scope-resolved, with origins and overrides, and
  deliberately ignoring `maxMemories`, because that ceiling is a budget on what a _turn_ carries and
  applying it to the read-back would hide a belief the assistant is one write away from acting on
  again. `DELETE /agent/memories/:id` deletes one held at the actor's own scope; an id the actor cannot
  see is answered as missing rather than refused, so the endpoint cannot be used to discover what the
  assistant believes about other people. A memory whose source conversation has since been truncated
  away is **kept**: it is shown with an origin that no longer resolves, because a history ceiling is a
  cost control and must never double as an eraser.

  **Recall over a transcript is a different feature and is not folded in here.** Searching what was
  _said_ earlier is retrieval over messages, and `Retriever`/`Reranker`/`EmbeddingProvider` already
  exist for that. Memory is the set of conclusions that ride every turn. Selecting _which_ of them ride
  a given turn, once there are more than the block holds, is `MemoryProvider.search` — see the
  relevance-selection changeset.

  **Budget.** The block is `maxMemories` lines (default 20), each capped at `maxFactChars` (default 240) when it is **written** — so the ceiling is a product of two numbers an operator set, rather than
  however much the model felt like writing down, and the push-back lands at the moment the model is
  writing an essay instead of a fact. Unlike a skill, a memory has no body/catalog split: a fact that
  cannot be stated in a line is a document, and documents are retrieval's job. Two new diagnostics
  events — `aviary:agent:memory.resolved` (scopes, offered, omitted, `promptChars`) and
  `aviary:agent:memory.written` (scope, chars) — so a turn whose input tokens jump can be attributed by
  name, and an operator can watch the agent's own write volume without reading anyone's rows.

  **Checkpoints.** One new position, `memory:digest`, holding the WHOLE digest — the scopes the
  resolver returned and the entries that survived precedence and the ceiling — placed after
  `persist:run:start` so `promptHash` keeps identifying a prompt version rather than a person. It is
  both what the block is rendered from and what a later `remember` call is authorized against, so a
  replay on a pod that would resolve the actor differently rebuilds the identical prompt and cannot
  widen what the turn may write. A `remember` call spends a plain read tool's positions
  (`persist:toolcall:<id>`, `tool:<id>`, `persist:toolexec:<id>`) and the write happens _inside_
  `tool:<id>`, which is what makes it idempotent under replay: a resumed run reads the stored record
  back instead of storing a second copy of a fact the model decided once. The digest is resolved once
  per run, so a memory written mid-turn reaches the model as that call's tool result rather than by
  rewriting a system block no journal position covers. `ToolKind` gains a sixth member, `'memory'`,
  carried by no `ToolSpec` — the tool is never registered and its branch is settled inside the
  already-journaled `persist:toolcall` checkpoint, the same way `ask` and `skill` are. Configure no
  memory and a turn's checkpoint sequence is byte-identical to one that never had the option.

### Patch Changes

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Answer an unidentified caller with 401, not 500.

  `HeaderActorResolver` threw a plain `Error` when `x-actor-id` was absent. Nest has no mapping for
  that, so the refusal reached the caller as `{"statusCode":500,"message":"Internal server error"}`
  with a stack trace logged at ERROR — on a request that was merely unauthenticated. Every agent
  route resolves the actor through this one call, so it applied to all of them.

  Two costs. A client cannot tell "you did not authenticate" from "the server is broken", so the
  correct client behaviour — get a token, retry — is indistinguishable from the one case where
  retrying is wrong. And because anonymous requests are routine for anything reachable on a network,
  each one wrote a stack trace, which is how a log stops being read.

  It now throws `UnauthorizedException`. The message is unchanged and still refuses to fabricate an
  identity or grant a default role.

  **If you wrote your own `ActorResolver`,** throw `UnauthorizedException` (or any `HttpException`)
  rather than a plain `Error` when you cannot identify the caller — the lib does not translate
  arbitrary errors on your behalf, so a plain one produces the 500 described above.

  The only behaviour change is the status code and the absence of the logged stack; nothing is
  persisted for a refused caller, exactly as before.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Run a turn's read tool calls concurrently instead of one at a time.

  A model routinely asks for several tools in one turn, and the loop executed them back to back — two
  independent three-second reads cost six seconds. They now overlap, and the turn costs the slowest
  call rather than their sum.

  What made this a determinism problem rather than a `Promise.all` is that the loop body is replayed
  by the durable engine, which hands out checkpoint positions from a monotonic counter as the body
  runs. Interleaving whole per-call blocks would order those positions by whichever tool happened to
  finish first, which differs between a run and its replay. Under dispatched steps it is worse than a
  `NonDeterminismError`: every dispatched tool call checkpoints under the SAME routing name, so a
  swapped pair raises no refusal at all and simply hands one call's output to another.

  So only the INVOCATIONS overlap. The `persist:toolcall` claims before them and the
  `persist:toolexec`/`persist:toolfail` writes after them stay strictly sequential in call order, and
  the invocations are all launched in one tick — both durable step primitives take their position on
  the call, before their first `await`, so the block is pinned in call order however the tools then
  settle. A turn is eligible only when every call's journaled kind is `read`: an `action` suspends on
  a human approval (parallelism buys nothing, and reserving an invocation position for a call that may
  be rejected spends a position the rejected branch never fills), and an `agent` delegation is
  `ctx.child`, whose parallel form is the runtime's own `ctx.all`.

  Two new optional `AgentLoopHooks`, so core stays runtime-agnostic:

  - `parallel(tasks)` — run tasks concurrently, resolve once EVERY one has settled, outcomes in input
    order. Its absence keeps the loop sequential, which is the honest answer for a runner that assigns
    positions anywhere other than the call. `settleAll` is the implementation both bundled runners
    pass. Settling all of them is load-bearing: a durable runner unwinds a turn by throwing, and a
    sibling abandoned part-way through its own dispatch is a tool nobody ever runs.
  - `patched(id)` — the runner's version gate (`ctx.patched`). Batching moves the `persist:toolcall`
    checkpoints ahead of the first execution, so a run that suspended mid-turn under the old shape
    keeps replaying against that shape instead of failing its resume.

  A turn with fewer than two calls, or one the runner has not opted in for, records exactly the
  checkpoint sequence it always did.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Every package's specs are typechecked now, and two published signatures were wrong.

  `typecheck` compiles each package's sources with `*.spec.ts` excluded; `typecheck:specs` compiles
  them with the specs included. Ten of the seventeen packages had no `typecheck:specs` at all, so
  their specs had never been typechecked — 372 errors were waiting in them, and behind those errors
  sat fakes that did not implement what they claimed and calls that named options and parameters
  nothing accepts.

  Two of the findings are in shipped code, not in the tests:

  - `nestjsAgentCodegen()` declared its return as the bare `CodegenExtension`, whose `transformRoutes`
    is optional, takes an `ExtensionContext`, and may return a promise or nothing. The extension
    always defines it, runs synchronously and reads no context, so every caller holding the result had
    to widen or cast to use it. It returns the new `AgentCodegenExtension` instead, which says so.
  - `LedgerQuotaStore.bump()` declared no parameters. It is a deliberate no-op — the ledger already
    holds the turn's tokens — but `QuotaStore.bump` takes `(actorRef, day, tokens)`, and a shorter
    function is assignable to a longer one, so the arity mismatch only showed up for a caller holding
    the concrete class. It now declares the parameters it ignores.

  Worth naming among the spec-side findings, because each is a check that was not happening:

  - Nine durable/runner module setups omitted `AgentModuleOptions.actorResolver`, which is required
    precisely so that no deployment can forget it.
  - Two `waitForRun` calls asked for `until: 'suspended'`, which is not one of the two states that
    option has. The engine treats anything but `'terminal'` as `'settled'`, so they were already
    waiting for what they meant.
  - The `@Agent` fixture typed `Required<AgentOptions>` — there to stop compiling when an option is
    added and forgotten — carried an `intake` that was not an `AgentIntake`, so the one field it was
    guarding was never guarded.
  - Two agent-loop fakes were built by spreading a class instance, which copies no prototype method;
    neither was the `AgentStore` its annotation claimed.
  - The React `fetch` fakes returned `Response`-shaped object literals behind `as unknown as typeof
fetch`, so neither the fakes nor the recorded call tuples were checked against `fetch` at all.

  `packages/core` is the case that needed a decision rather than a fix: its specs use
  `@dudousxd/nestjs-agent-testing`, which depends on core, so declaring it would close a
  core → testing → core cycle in `build`. Its spec project resolves both packages to their TypeScript
  sources instead — exactly what Vitest's own alias already does — so the typechecker sees what the
  tests execute and no package graph edge is added.

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Resolve a tool call's kind inside its `persist:toolcall` checkpoint instead of in the loop body.

  The kind decides the call's control flow — an `action` suspends the run on an approval signal
  (`signal:tool:<runId>:<callId>`), anything else records a step — and it was read from
  `deps.registry` in the workflow body, so the branch depended on the registry of whichever process
  ran it. A process whose registry lacks the tool (a module that never declared it, a surface that
  mounts no tools, a pod still booting) read `undefined`, fell back to `'read'`, and asked for a
  `tool:` checkpoint where the history held `signal:tool:` — `NonDeterminismError` on resume. Where
  the execution is dispatched, that same misresolution sent the call on to a worker that DOES have
  the tool, running an action nobody approved.

  The lookup now happens inside the already-journaled `persist:toolcall:<callId>` step and is
  returned from it, so replays read the recorded kind instead of asking their own registry. Same step
  name at the same position, so in-flight runs keep replaying. `AgentRunSteps.tool` additionally
  refuses to run a tool its own registry knows as an `action` when the dispatch says it was
  auto-executed.

  Replay-integrity failures now propagate out of the agent loop and the `agent.run` workflow
  untouched. Both `catch` blocks reacted to one by writing more checkpoints — a `persist:toolfail`, a
  `persist:run:fail`, a `deactivate` — and on a journal that has already diverged each of those asks
  for a position the history cannot supply, so the recovery attempt raised its own refusal and THAT
  is what surfaced: a message naming the wrong seq and two checkpoints from the recovery path rather
  than the two that actually disagreed. The workflow still settles the stream, so a subscriber does
  not hang on a run the engine is about to fail.

- Updated dependencies [[`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4)]:
  - @dudousxd/nestjs-agent-core@0.13.0

## 0.11.1

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

## 0.11.0

### Minor Changes

- [#63](https://github.com/DavideCarvalho/nestjs-agent/pull/63) [`70f3d57`](https://github.com/DavideCarvalho/nestjs-agent/commit/70f3d57dcebd9aec631adc66c40d0715472115d9) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Let a tool say whether it exists here, and who may use it

  Two optional methods on `ToolHandler`, both evaluated per turn and both with DI available:

  - `isEnabled()` — is this capability part of this deployment? The feature-flag seam.
  - `canUse(actor)` — may THIS actor use it? The per-user seam, on the tool rather than in one
    app-wide policy.

  Neither existed before. `roles`/`ability` are checked by a single `RolesPolicy` shared by every
  tool, and an agent's `tools` allow-list is fixed when the agent is declared — so "turn this tool
  off in staging" or "only accounts on the paid plan get it" had nowhere to live but conditionally
  registering the provider, which happens while `@Module` metadata is built, in most apps before
  configuration is even loaded.

  Both gates run when the turn's tool list is built, so a tool that fails either is never shown to
  the model, and again on invoke, which is what stops a HITL action approved before a flag moved from
  executing after it. Order is `isEnabled` → `RolesPolicy` → `canUse` → the agent's allow-list; every
  layer only removes tools, so none of them can widen what a turn reaches.

  Also `@AiTool({ enabled })` for availability that needs no injected service — a boolean, or a
  predicate re-read every turn — and a new `ToolDisabledError`, kept distinct from
  `ToolForbiddenError` (wrong actor) and `ToolNotFoundError` (no such tool) so a log says which of
  the three to go fix.

  Purely additive: a tool that declares none of this behaves exactly as before.

### Patch Changes

- Updated dependencies [[`70f3d57`](https://github.com/DavideCarvalho/nestjs-agent/commit/70f3d57dcebd9aec631adc66c40d0715472115d9)]:
  - @dudousxd/nestjs-agent-core@0.12.0

## 0.10.1

### Patch Changes

- Updated dependencies [[`7c27376`](https://github.com/DavideCarvalho/nestjs-agent/commit/7c273763eeb6d5841028612d81acc63b2a8dd4eb)]:
  - @dudousxd/nestjs-agent-core@0.11.0

## 0.10.0

### Minor Changes

- [`9f2a22c`](https://github.com/DavideCarvalho/nestjs-agent/commit/9f2a22c978b6268cd8d7443fd3a21e524f415cf5) - Add `AgentModuleOptions.surface: 'http' | 'engine' | 'both'` (default `'both'`, zero behavior
  change when omitted) so an API pod and a worker pod can each load `AgentModule` without either
  one doing the other's job:

  - `'engine'` mounts NO controllers — the worker fleet's pod loads the `agent.run` durable workflow
    and its dispatched steps (`AgentRunSteps.llm`/`.tool`) exactly as `'both'` does today.
  - `'http'` mounts every controller (chat/threads/tool-call/quota/agents/attachments), fully
    functional, but never registers the dispatched-step handlers — an API pod that also registered
    them subscribed their queues and ran LLM/tool work meant for the worker fleet (the durable
    skew-protection crash-loop this option fixes). HITL signal delivery (`workflows.signal`) and
    starting a run both keep working from the http side.

  `AgentDurableModule.forRoot({ surface })` mirrors the same option (it can't be inferred from
  `AgentModule`'s own options — Nest builds a module's provider list before any injected value
  exists to read); the `agentDurable(options)` one-call helper threads a single `surface` to both.

## 0.9.0

### Minor Changes

- [`70114eb`](https://github.com/DavideCarvalho/nestjs-agent/commit/70114ebb9a7a3702d2efdb11e0dea6956a7ba8db) - Retry a classified-transient tool error (DB deadlock, lock-wait timeout, serialization failure) in
  place — no new durable checkpoint, just repeated attempts inside the same tool-call step:

  - `isTransientToolError` (core): structural classifier for MySQL (`ER_LOCK_DEADLOCK` /
    `ER_LOCK_WAIT_TIMEOUT`, codes `1213`/`1205`), Postgres (SQLSTATE `40001`/`40P01`), `SQLITE_BUSY`,
    and a matching `deadlock|lock wait timeout|serialization failure` message — checked on the error
    and one level of `cause`.
  - `invokeWithTransientRetry` (core): wraps a thunk with `{ attempts, backoffMs, classify }`,
    rethrowing immediately on a non-transient or control-flow error.
  - `toolTransientRetry` option (on the same surface as `toolTimeoutMs`): default ON
    (`{ attempts: 2, backoffMs: 150 }` with the default classifier); `{ classify }` to widen/narrow;
    `false` to disable. Wired at BOTH execution sites — the local agent-loop path and the
    durable-dispatched `AgentRunSteps.tool` handler (via `ToolStepEnvelope.transientRetry`'s
    wire-safe numeric half; a custom `classify` never rides the wire, resolved from local module
    options on the serving worker instead).
  - New `aviary:agent:tool.retry` diagnostics point event (`{ toolName, toolCallId, attempt, message
}`) emitted per retry.

### Patch Changes

- Updated dependencies [[`70114eb`](https://github.com/DavideCarvalho/nestjs-agent/commit/70114ebb9a7a3702d2efdb11e0dea6956a7ba8db)]:
  - @dudousxd/nestjs-agent-core@0.10.0

## 0.8.2

### Patch Changes

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

- Updated dependencies [[`107fcc2`](https://github.com/DavideCarvalho/nestjs-agent/commit/107fcc2c0079f97c3cc9ff8c83f2dc41070244d5)]:
  - @dudousxd/nestjs-agent-core@0.9.0

## 0.8.1

### Patch Changes

- Updated dependencies [[`3d256d4`](https://github.com/DavideCarvalho/nestjs-agent/commit/3d256d4027c7ad819f8ec908425d52887e67da3f)]:
  - @dudousxd/nestjs-agent-core@0.8.0

## 0.8.0

### Minor Changes

- [`6263338`](https://github.com/DavideCarvalho/nestjs-agent/commit/6263338cf86df7b51cb082d5d2d575987cd13383) - Agent run tracing — every run now emits diagnostics SPANS correlated by `traceId = runId`, so the
  Telescope TRACES tab renders the turn as a nested waterfall (llm calls, tool executions, retrieval,
  follow-ups, with durations and error phases):

  - core: four span events (`llm.turn`, `tool.execution`, `retrieval`, `follow-ups`) on the agent
    diagnostics channel, emitted from INSIDE the checkpointed step bodies — replayed (cached) steps
    never re-emit. Payloads are metadata-only (model id, token counts, tool name/type, step index —
    never prompt/output text). `traceLlmTurn`/`traceToolExecution` are exported for remote execution
    sites.
  - nestjs: the dispatched-step handlers (`AgentRunSteps.llm`/`.tool`) emit the identical spans from
    whichever worker actually executes; the dispatch envelopes gained the additive fields the span
    identity needs (`step` on the llm input; `toolCallId`/`toolType` on the tool input).

  Rendering requires the span-aware diagnostics bridge (`@dudousxd/nestjs-diagnostics-telescope`
  0.7+) and `@dudousxd/nestjs-telescope` 1.17+ (explicit `RecordInput.traceId`); without them the
  spans are emitted but unobserved (zero cost — phase envelopes are gated on subscriber presence).

### Patch Changes

- Updated dependencies [[`6263338`](https://github.com/DavideCarvalho/nestjs-agent/commit/6263338cf86df7b51cb082d5d2d575987cd13383)]:
  - @dudousxd/nestjs-agent-core@0.7.0

## 0.7.0

### Minor Changes

- [`71b8d42`](https://github.com/DavideCarvalho/nestjs-agent/commit/71b8d42d211d28516929298c44e6868d8925cc02) - Live-testing fixes from the first dispatched-steps consumer:

  - **CRITICAL — durable turns on the BullMQ thin worker no longer corrupt their history.** The
    workflow's control-flow classification used `instanceof WorkflowSuspended`, but the thin worker's
    suspends throw `@dudousxd/durable-worker`'s `Suspend` — a different class — so every dispatched
    llm step's suspend was misclassified as a real failure: the failure path ran DURING the suspend,
    emitted extra checkpoints, and the resumed replay died with NondeterminismError ("Something went
    wrong: workflow suspended" on every turn). All three classification sites (workflow catch, the
    loop's `isControlFlowError` hook, the runner's start-suspend swallow) now use durable-core
    0.52.0's marker-based `isWorkflowControlFlowSignal` — the peer floor rises to
    `@dudousxd/nestjs-durable-core >= 0.52.0` accordingly.
  - **Dashboard mounted in an Inertia host:** an Inertia `<Link>` visit to the console received plain
    HTML and rendered it inside the client's about:srcdoc error modal, where relative assets die on
    CORS. The UI controller now answers `X-Inertia` requests with the protocol's own external-redirect
    mechanism (`409` + `X-Inertia-Location`), so in-app links full-load the console correctly.
  - **Approvals attribution defaults to the AgentModule-configured actor resolver** (`@Global`,
    already exported) — zero config for hosts whose console auth matches chat auth; the
    `approvalActorRef` override is now generically typed (`AgentDashboardOptions<TReq>`, mirroring
    `ActorResolver<TReq>`) for hosts where it differs.

## 0.6.0

### Minor Changes

- [`781a30f`](https://github.com/DavideCarvalho/nestjs-agent/commit/781a30f6579d5b9a69f341b8eeac02c273dbb8a1) - `dispatchedSteps` now defaults to ON under `durable: true` (opt out with `dispatchedSteps: false`).
  The cross-process-sink requirement was never specific to dispatched steps — under `durable: true`
  the turn already runs on whichever worker takes `agent.run`, which may not hold the SSE connection
  — and the `AgentRunSteps` worker groups are always registered, so the routed steps are never
  unserved. Dispatching the model call and tool executions is the correct production posture: the
  run leaves its pod during the two long steps and the llm step gets engine retry.

  Upgrade note: a run in flight across a deploy that changes the effective mode replays with
  different step kinds and fails that one turn (send the message again). Multi-pod fleets should
  already be on a cross-process sink (e.g. `RedisTokenStreamSink`) for durable streaming; the boot
  warning now names `dispatchedSteps: false` as the alternative.

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

- [`1c44152`](https://github.com/DavideCarvalho/nestjs-agent/commit/1c4415295a6280527e762f13e6aed48099ae5ca5) - Dispatched turn steps — opt-in `dispatchedSteps: true` (requires `durable: true`) dispatches the
  turn's two LONG steps as routed durable steps instead of in-process localSteps, so a run is no
  longer pinned to its pod while the model call or a tool executes:

  - `AgentRunSteps.llm` (`@Step({ retries: 3 })`): resolves the model/sink/tool definitions from the
    serving worker's own DI and streams from wherever it runs. `AgentRunSteps.tool` (no retries —
    tool idempotency is the app's domain): rebuilds the tool ctx and applies the tool timeout
    handler-side. Both are ALWAYS registered by `AgentDurableModule` (worker groups always served);
    the flag only controls dispatching. Bookkeeping steps (persist/quota/stream markers) stay local —
    dispatching a 10ms DB write through a queue buys nothing.
  - Core: serializable `LlmStepEnvelope`/`ToolStepEnvelope` (`ToolStepCtx` excludes `host`, re-attached
    from DI handler-side; the llm envelope carries the `actor` and the handler re-derives tool
    definitions — live schema instances never cross the wire), optional `dispatchLlm`/`dispatchTool`
    loop hooks (absent = behavior identical to before), exported `withToolTimeout`.
  - Core: new `AgentLoopHooks.isControlFlowError` — the durable runner's suspend/continue-as-new
    signals now escape the loop's tool catch instead of being mispersisted as tool failures (which
    diverged on replay).
  - Multi-pod fleets MUST wire a cross-process token sink (e.g. `RedisTokenStreamSink`); a boot
    warning fires when `dispatchedSteps` is on with the default in-process sink.

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

## 0.4.1

### Patch Changes

- [`66e9ad8`](https://github.com/DavideCarvalho/nestjs-agent/commit/66e9ad80347c6e1488041e643a1e8d881410de6f) - Fix `durable: true` under nestjs-durable >= 0.31 (core >= 0.50): `AgentRunWorkflow` now checkpoints
  the turn's steps with `ctx.localStep` instead of `ctx.step`. Since durable's single-step collapse,
  `ctx.step(name, input)` is ALWAYS dispatched — the name becomes a routing worker-group and the
  closure was silently serialized away as "input", so every agent step landed on a queue no worker
  serves (`persist-user@<tenant>`, `deactivate@<tenant>`) and the run suspended forever. The agent
  loop's steps are closures over in-process turn state (model provider, open SSE sink) with dynamic
  checkpoint-identity names, which is exactly what `localStep` is for — same durability (checkpointed
  outputs, replay skips completed steps, HITL suspend/resume), no dispatch.

  Durable peer floors raised to match: `@dudousxd/nestjs-durable >= 0.34.0`,
  `@dudousxd/nestjs-durable-core >= 0.51.0` (the versions that expose `localStep` on `WorkflowCtx`).

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

- [`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46) - Stream structured turn events so clients render text, reasoning, and live tool-call cards — not just
  text. The sink now carries an NDJSON `AgentStreamEvent` vocabulary (`step-start`/`step-finish`,
  `text`, `reasoning`, `tool-input-start`/`-delta`/`-available`, `tool-output`/`-error`): the AI-SDK
  adapter emits model parts, the loop emits tool results, the chat controller forwards each line as an
  SSE frame, and the React transport maps them back to the AI SDK UI-message chunk protocol. Tool
  cards (input streaming → rendered output) and reasoning now appear live via `useAgentChat`, matching
  a native `streamText().toUIMessageStream()` while keeping the sink a format-agnostic byte buffer
  (durable buffering/replay untouched).

  Note: this changes the on-the-wire chat SSE protocol from `{delta}` text frames to
  `AgentStreamEvent` frames — upgrade backend (`@dudousxd/nestjs-agent`) and client
  (`@dudousxd/nestjs-agent-react`) together.

- Updated dependencies [[`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46), [`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46), [`d1679b0`](https://github.com/DavideCarvalho/nestjs-agent/commit/d1679b01f65b09ab35ac2cbb304d1f21c0a1ad46)]:
  - @dudousxd/nestjs-agent-core@0.3.3

## 0.3.2

### Patch Changes

- Add a `GET <agentPath>/agents` catalog endpoint that lists the discovered
  `@Agent` classes (`{ name, description, isDefault? }`) from the `AgentRegistry`,
  so a frontend picker can source personas from the backend instead of hardcoding
  them. `@Agent({ description })` is now also carried through discovery onto the
  `AgentDefinition` (it was previously declared but dropped). `ActorResolver` is
  made generic over the request type (`ActorResolver<TReq = unknown>`) so hosts
  can implement it against their concrete request without an `unknown`-narrowing
  guard; the default type parameter keeps every existing call site source-compatible.
- Updated dependencies
- Updated dependencies [ad8e446]
  - @dudousxd/nestjs-agent-core@0.3.2

## 0.3.1

### Patch Changes

- Updated dependencies [[`60dcc7d`](https://github.com/DavideCarvalho/nestjs-agent/commit/60dcc7db3764a7d60cb6e4d586f1c0fe7b05ee04)]:
  - @dudousxd/nestjs-agent-core@0.3.1
