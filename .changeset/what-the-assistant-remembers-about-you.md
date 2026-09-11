---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
'@dudousxd/nestjs-agent-telescope': patch
---

Memory: what the assistant concluded about a person, carried across turns and across threads.

Everything the agent works out about someone dies at the end of the turn. The next conversation
re-asks which units they report in, which fiscal year their org uses, that they were corrected about
this last week. The two places a deployment can put that today are both wrong: the system prompt,
which is authored by a developer and identical for everyone, or retrieval, which answers from
documents nobody wrote about this person.

A **memory** is a keyed fact at a scope. `{ key: 'fiscal-year', text: 'they report on the calendar
year', scope: 'actor:u1' }`. It rides the system block as one line, the model writes it through a
built-in `remember` tool, and the person it is about can read every one of them back and delete any
of them.

**It is not RAG, and the difference is not cosmetic.** Retrieval answers *what do the documents say*
and cites them; memory answers *what did I decide about you* and has no source to go and fix. So
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
records only *which* scope it outranked — the agent follows one procedure either way. A memory is a
value, so the entry carries the beaten **text** too, and the block prints it underneath:

```text
- [actor:u1] fiscal-year: they report on the calendar year
    ↳ [global] instead has: the fiscal year starts in October
```

An agent that knew only that a wider value existed could tell the user nothing except which one it
picked.

**Write authority: an agent proposes, a person publishes.** `memoryWriteVerdict` carries the same
four rules as `skillWriteVerdict`, and rule three bites harder here — nothing but a human may write
above its own scope, whatever elevation a host grants. A tenant *skill* an agent could publish is a
procedure anyone in the tenant can edit by talking to the assistant; a tenant *memory* is a fact
everyone in the tenant is then answered from, with no document to inspect and nobody aware it was
written. The `remember` tool enforces it by shape as well as by check: **it has no scope parameter**,
so there is no request rule three has to refuse. Promotion to a wider scope is a human act in the
host's own console.

**Forgetting is part of the feature, not a console someone might build.** `GET /agent/memories`
returns everything this actor can reach — scope-resolved, with origins and overrides, and
deliberately ignoring `maxMemories`, because that ceiling is a budget on what a *turn* carries and
applying it to the read-back would hide a belief the assistant is one write away from acting on
again. `DELETE /agent/memories/:id` deletes one held at the actor's own scope; an id the actor cannot
see is answered as missing rather than refused, so the endpoint cannot be used to discover what the
assistant believes about other people. A memory whose source conversation has since been truncated
away is **kept**: it is shown with an origin that no longer resolves, because a history ceiling is a
cost control and must never double as an eraser.

**Recall over a transcript is a different feature and is not folded in here.** Searching what was
*said* earlier is retrieval over messages, and `Retriever`/`Reranker`/`EmbeddingProvider` already
exist for that. Memory is the set of conclusions that ride every turn. Selecting *which* of them ride
a given turn, once there are more than the block holds, is `MemoryProvider.search` — see the
relevance-selection changeset.

**Budget.** The block is `maxMemories` lines (default 20), each capped at `maxFactChars` (default
240) when it is **written** — so the ceiling is a product of two numbers an operator set, rather than
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
(`persist:toolcall:<id>`, `tool:<id>`, `persist:toolexec:<id>`) and the write happens *inside*
`tool:<id>`, which is what makes it idempotent under replay: a resumed run reads the stored record
back instead of storing a second copy of a fact the model decided once. The digest is resolved once
per run, so a memory written mid-turn reaches the model as that call's tool result rather than by
rewriting a system block no journal position covers. `ToolKind` gains a sixth member, `'memory'`,
carried by no `ToolSpec` — the tool is never registered and its branch is settled inside the
already-journaled `persist:toolcall` checkpoint, the same way `ask` and `skill` are. Configure no
memory and a turn's checkpoint sequence is byte-identical to one that never had the option.
