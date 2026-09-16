# @dudousxd/nestjs-agent-telescope

## 0.8.10

### Patch Changes

- fix(deps): update dependency @dudousxd/nestjs-diagnostics to v0.7.2 ([#151](https://github.com/DavideCarvalho/nestjs-agent/issues/151))

- Updated dependencies []:
  - @dudousxd/nestjs-agent-core@0.15.5

## 0.8.9

### Patch Changes

- Updated dependencies [[`3a3e75f`](https://github.com/DavideCarvalho/nestjs-agent/commit/3a3e75f6aa3b3efaaeb6235a0d4bb4048357458b)]:
  - @dudousxd/nestjs-agent-core@0.15.4

## 0.8.8

### Patch Changes

- Updated dependencies [[`df889d9`](https://github.com/DavideCarvalho/nestjs-agent/commit/df889d953f7d92ace46d22b1d33db2cdab88f7c2)]:
  - @dudousxd/nestjs-agent-core@0.15.3

## 0.8.7

### Patch Changes

- Updated dependencies [[`648fef6`](https://github.com/DavideCarvalho/nestjs-agent/commit/648fef61c336022ffb126ac15ab325387c05c49a)]:
  - @dudousxd/nestjs-agent-core@0.15.2

## 0.8.6

### Patch Changes

- fix(deps): update dependency @dudousxd/nestjs-diagnostics to v0.7.1 (#110)

- Updated dependencies []:
  - @dudousxd/nestjs-agent-core@0.15.1

## 0.8.5

### Patch Changes

- Updated dependencies [[`3061f77`](https://github.com/DavideCarvalho/nestjs-agent/commit/3061f77548d48a8aa88b02eca46b04d24848646a)]:
  - @dudousxd/nestjs-agent-core@0.15.0

## 0.8.4

### Patch Changes

- Updated dependencies [[`d7f2cf2`](https://github.com/DavideCarvalho/nestjs-agent/commit/d7f2cf260ab0e87a012b21d681f805eb6758129a), [`31caa9e`](https://github.com/DavideCarvalho/nestjs-agent/commit/31caa9e48e9b8be948b54dd252057a01355f4924)]:
  - @dudousxd/nestjs-agent-core@0.14.0

## 0.8.3

### Patch Changes

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

- Updated dependencies [[`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4), [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4)]:
  - @dudousxd/nestjs-agent-core@0.13.0

## 0.8.2

### Patch Changes

- [#69](https://github.com/DavideCarvalho/nestjs-agent/pull/69) [`f48952e`](https://github.com/DavideCarvalho/nestjs-agent/commit/f48952e6dc9c7264543d4e2f56a0330dd8194131) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Stop linking every `Run` cell at a trace that cannot exist.

  The `runId` column defaulted to `'#/traces/{runId}'`, and that default could only 404. Telescope's
  trace waterfall is keyed by **`traceId`** — its `LinkSpec` doc says so in as many words, and
  `TracesService.getWaterfall` resolves it with `storage.get({ traceId })` — while an agent's `runId`
  is a different identifier that `AgentTelescopeWatcher` never ties to one: it records `type: 'agent'`
  entries and stamps no trace at all.

  So clicking any Run cell on the shipped dashboard answered:

  ```json
  {
    "statusCode": 404,
    "path": "/telescope/api/traces/<runId>/waterfall",
    "message": "No entries for trace <runId>.",
    "errorCode": "NOT_FOUND"
  }
  ```

  `runHref` is now opt-in, exactly like `threadHref` beside it: a host that has a run viewer passes
  its own template, and one that does not gets plain text. Reading the route contract correctly and
  substituting the wrong key into it is the whole bug, so the default is gone rather than repointed.

## 0.8.1

### Patch Changes

- [#67](https://github.com/DavideCarvalho/nestjs-agent/pull/67) [`6b723c6`](https://github.com/DavideCarvalho/nestjs-agent/commit/6b723c6beea86c38b0219b83f602b39cbb34c040) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Fix paging on the Agent tab's list tables: `Next` did nothing, then stopped responding entirely.

  `resolvePage` and `resolveLimit` read their value behind a `typeof raw === 'number'` guard. That
  rejects every value a real request can carry: the dashboard serializes a panel's query into the URL
  and the host controller passes `@Query()` through verbatim, so `?page=2&limit=20` reaches the
  provider as the **strings** `'2'` and `'20'`. Both fell through to the default, so every request
  returned page 1 — verified against a deployment: `?page=2&limit=5` answered with `page: 1`,
  `limit: 50` and the same 50 rows as `?page=1`.

  The visible failure was worse than a stuck first page. The pager renders the page the _response_
  reports, so `Next` appeared to do nothing; and because the control then keeps computing `page + 1`
  from that pinned `1`, the second click requests the page the UI is already on, React skips the
  re-render, and the pager stops responding at all — `Prev` never re-enables either, short of a reload.

  Both helpers now accept a numeric string as well as a number, and reject anything that is not a
  positive number (`''`, `'banana'`, `'0'`, `'-2'`, `'NaN'`) rather than letting it reach the
  read-model as a `NaN` offset. The existing specs passed real numbers throughout, which is why the
  guard survived; the new ones use the string form the wire actually delivers.

## 0.8.0

### Minor Changes

- [#65](https://github.com/DavideCarvalho/nestjs-agent/pull/65) [`2ab59e2`](https://github.com/DavideCarvalho/nestjs-agent/commit/2ab59e291529f70324e51b9d7a31f5d6e01121a4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Two RAG sections on the Agent tab, and a supported way for a host to put its own panels there.

  The tab had Overview, Spend, Reliability, Activity, Approvals and Tools, and nothing for retrieval — even though the framework ships a full retrieval stack. It now has **Retrieval** (retrievals, zero-hit rate, passages per retrieval, a latency histogram with p50/p95/p99 markers, a top-score histogram, and a retrievals/zero-hits trend) and **Retrieval sources** (retrievals by store, by retriever kind, a per-collection rollup, and the slowest retrievals in the window).

  These are fed by real telemetry — the `aviary:rag:retrieval` events `@dudousxd/nestjs-agent-rag` now emits — not derived from tool-call rows, which cannot distinguish a retrieval that found nothing from one that found exactly what was needed. A new `RagTelescopeWatcher` records them under their own `agent-rag` entry type, which also gives the Entries screen a RAG filter tagged by store, retriever and zero-hit. The type is separate from `agent` on purpose: retrieval is per-tool-call where a run is per-conversation, so sharing one storage window would let retrieval traffic push `run.finished` out of it and quietly zero the Runs and Tokens stats.

  The latency panel is a real histogram, unlike the run-duration pair beside it: retrieval events carry the raw per-call duration, so there are samples to bucket. The score histogram is bound to **one** retriever kind (`query: { retriever: 'embedding' }`) because a cosine similarity, a BM25 score and an RRF rank score share no scale — a histogram over all three has bins that mean a different thing per bar, and the reading it invites ("our scores collapsed") would be a change in traffic mix rather than in retrieval quality.

  These panels read Telescope's own storage rather than the durable `AGENT_GOVERNANCE_QUERIES` read-model, which is a deliberate exception to the preference stated in `agent-data-providers.ts`. There is no durable write to piggyback on: retrieval happens inside the rag package, which holds no store handle, so the durable route would mean a new table plus a migration in `store-mikro-orm`, `store-drizzle` and `testing`, and a row written per retrieval — write amplification on the hot path of the operation an agent performs most often. What it would buy is that a p95 and a zero-hit rate survive a pod restart. The honest consequence, documented in the code: these panels are a live view over Telescope's retention window, not a ledger.

  **Host contributions.** `agentTelescopeExtension({ providers, sections })` registers an application's own data providers and dashboard sections on this page — how an app puts its knowledge-base collections or ingestion activity next to the library's retrieval panels. This has to go through this extension rather than a second one: the UI derives the data request path from the dashboard id (`agent.overview` → `GET /ext/agent/data/:provider`) and the server 404s when the provider's owning extension does not match that segment, so a provider contributed elsewhere is simply unreachable from a panel on this page. Host provider names must sit under their own prefix; anything starting with `agent.` is refused at boot with a message that names it, rather than surfacing as Telescope's generic "contributed by both agent and agent" collision error. Host sections are appended after the built-in ones, so a host's layout can never push a built-in section out of the row it was sized for.

## 0.7.1

### Patch Changes

- Updated dependencies [[`70f3d57`](https://github.com/DavideCarvalho/nestjs-agent/commit/70f3d57dcebd9aec631adc66c40d0715472115d9)]:
  - @dudousxd/nestjs-agent-core@0.12.0

## 0.7.0

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

## 0.6.1

### Patch Changes

- Updated dependencies [[`70114eb`](https://github.com/DavideCarvalho/nestjs-agent/commit/70114ebb9a7a3702d2efdb11e0dea6956a7ba8db)]:
  - @dudousxd/nestjs-agent-core@0.10.0

## 0.6.0

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

## 0.5.1

### Patch Changes

- Updated dependencies [[`3d256d4`](https://github.com/DavideCarvalho/nestjs-agent/commit/3d256d4027c7ad819f8ec908425d52887e67da3f)]:
  - @dudousxd/nestjs-agent-core@0.8.0

## 0.5.0

### Minor Changes

- [`6263338`](https://github.com/DavideCarvalho/nestjs-agent/commit/6263338cf86df7b51cb082d5d2d575987cd13383) - Live-feedback fixes for the Agent tab + automatic dedup:

  - The recent-runs table no longer overflows its card: slimmed to started/run/agent/status/duration/
    error/promptHash (thread/actor/retries/errorCode detail lives in the standalone console; the
    provider row shape is unchanged).
  - Run duration renders as p50/p95 stat panels — the previous `distribution` panel was a permanently
    empty histogram (the governance read has percentiles, not samples).
  - The watcher claims its channels (diagnostics 0.7 claim registry, released on `dispose()`), so the
    generic diagnostics bridge skips them automatically — consumers delete their hand-written
    `agent:*` exclude lists.

### Patch Changes

- Updated dependencies [[`6263338`](https://github.com/DavideCarvalho/nestjs-agent/commit/6263338cf86df7b51cb082d5d2d575987cd13383)]:
  - @dudousxd/nestjs-agent-core@0.7.0

## 0.4.0

### Minor Changes

- [`781a30f`](https://github.com/DavideCarvalho/nestjs-agent/commit/781a30f6579d5b9a69f341b8eeac02c273dbb8a1) - Telescope bridge catches up with the governance data (audit items 1-8, 10):

  - The Agent tab surfaces the durable governance reads: Reliability (success/error rate stats, run
    duration as a `distribution` panel with p50/p95 markers, runs-by-agent, error breakdown, run
    trend, recent runs with promptHash chips and 500-char-capped errorMessage — `DataProvider`
    output bypasses Telescope's entry-level `redact()`, so the provider self-caps), durable recent
    tool calls / threads, pending-approvals count + table, and tool stats.
  - The watcher now records ALL agent diagnostics events — `run.failed`, `delegated`, and
    `retrieved` were silently dropped — driven by the new canonical `AGENT_DIAGNOSTIC_EVENTS` export
    (compile-time-checked against the channel registry) + `agentDiagnosticKey()` helper (core). Pass
    those keys to the generic diagnostics bridge's `exclude` to avoid double-recording (doc note
    added, mirroring the media bridge).
  - `agentTelescopeExtension({ threadHref?, runHref? })` — deep-link columns on every thread/run
    table, matching the durable/media bridges' convention. The watcher gained `dispose()`.
  - The ephemeral event-storage tools provider is deprecated and no longer bundled: the durable
    writes always land before the diagnostics event fires, and only the durable read-model sees
    `pending_approval`, so the ephemeral view had no unique value left.

### Patch Changes

- Updated dependencies [[`eb3aaff`](https://github.com/DavideCarvalho/nestjs-agent/commit/eb3aaff531cc923de1d0bccebb2b0690b4c92263), [`781a30f`](https://github.com/DavideCarvalho/nestjs-agent/commit/781a30f6579d5b9a69f341b8eeac02c273dbb8a1)]:
  - @dudousxd/nestjs-agent-core@0.6.0

## 0.3.5

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
