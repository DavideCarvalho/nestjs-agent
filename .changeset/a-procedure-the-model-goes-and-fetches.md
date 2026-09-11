---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
'@dudousxd/nestjs-agent-telescope': patch
---

Skills: an authored procedure the model pulls in when a task calls for it.

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
