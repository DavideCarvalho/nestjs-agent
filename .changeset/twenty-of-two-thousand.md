---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
---

Memory: relevance selection, always-on facts, and a block that says whose note it is.

The first cut of memory shipped a plain scoped read and no search, on the argument that *if the whole
memory set fits in the prompt, a semantic search over it is a search for something the model is
already reading*. That is true given the ceiling — and the ceiling was 20, which made the argument
circular: it justified not retrieving by pointing at a limit that existed because nothing retrieved.
A person accumulates preferences over months; twenty facts is an afternoon.

**The prompt budget must be bounded. The store has no reason to be.** `MemoryDigest.omitted` already
admitted it: at any real size the block was partial, and what survived was chosen by **scope**, not by
relevance to the turn.

**Choosing by scope fails quietly, and worse than the ceiling does.** A turn's candidates are the
*union* of every resolved scope — a few hundred of yours, several hundred of your unit's, thousands of
your base's. Narrowest-first means that as soon as one person has twenty notes of their own, **nothing
their organisation knows ever reaches the prompt again**. The facts that apply to the most people are
the first dropped, and the only trace is a non-zero `omitted`. That looks exactly like the feature
working.

So **precedence** and **selection** are now two things:

- Precedence resolves a *conflict* — two memories at one `key`, narrower wins, the beaten value rides
  along as `overrides`. Scope decides this, unchanged.
- Selection decides *which of thousands* appear at all. That is relevance to the turn.

**`MemoryProvider.search({ scopes, query, limit, ctx })`, optional.** Omit it and every turn is the
plain scoped read, byte-identical to before — a deployment with twenty memories must not have to stand
up an index, and one with two thousand uses whatever it already runs. The host owns the index for the
same reason it owns the rows; the library owns resolution, precedence, budget and the journal. Three
clauses: filter to `scopes` **before** ranking, rank the *keys* and take the best `limit` (precedence
resolves a key to one line, so keys are the block's unit), and return **every record sharing a
returned key** — a search that returned the `global` half of a conflict and not the `actor:` half would
render the org default as the answer, and nothing downstream can detect that. One SQL query either way.

**Scope gates, and gates first.** A search that ranks before it filters is a cross-tenant leak wearing
a relevance score: the nearest neighbour to *"what is our rollback policy"* is another base's rollback
policy. `resolveMemoryDigest` drops anything returned outside the resolved scopes — not even carried as
a beaten value, since an `overrides` line prints it just the same — so a host's filter bug costs
throughput rather than privacy. The drop is a backstop, not the boundary.

**It is searched with the user's own turn text, and nothing else.** The only thing available before the
first model call, which is where memory has to be; and already a journaled input to the run, so it
needs no determinism machinery of its own. **What it fails at is a turn with no topic** — *"and the
other thing?"*, *"yes"*. A rolling transcript window drifts toward whatever dominated the conversation,
and asking the model to request a recall makes it recall-on-demand, which is what working memory
deliberately is not. The answer is pinning.

**`MemoryRecord.pinned` — always-on, and categorical rather than a priority number.** *"Never purge the
app-config cache during business hours"* is never semantically close to a question about rollbacks, so
under pure relevance it silently stops appearing. A number would inflate (everybody picks 100, then
something has to outrank 100), carry no reviewable meaning (no natural scale, and an admin's 100 sorts
identically to an end user's while meaning something else), and compete with relevance, which is
already a continuous ordering — does priority 8 beat a substantially better match, and by how much? A
category becomes a **budget** instead: pinned entries are taken from `maxMemories` first, recall fills
the rest, and the ceiling stays the product of two numbers an operator set. Overflow still bites, but
is reported on its own as `MemoryDigest.pinnedOmitted` (and on `memory.resolved`) — ordinary omission is
the budget working, a dropped always-on memory is a deployment's standing policies having stopped
reaching any prompt. A pin belongs to the *question*, so a personal override of a pinned key is pinned
too. **An agent cannot pin its own writes:** `StoreMemoryInput` has no such field and the `remember`
tool no such parameter, the same enforcement-by-shape that keeps `scope` off it — an agent that could
pin its own conclusion has granted itself a permanent place in every future prompt.

**The block is framed by `origin.author`, in two sections.** A wide-scope memory is usually *published
by an administrator*, not concluded by the agent — that is what the write-authority rules make
promotion a human act for. One framing over the whole list told the model to treat an organisational
decision as its own guess, and *"prefer what the user says now"* handed any user an override of company
policy by asserting the opposite. Not a jailbreak: the documented instruction. Now what a person
**stated** is framed as an instruction, with a user contradiction to be surfaced as a conflict naming
the note and its scope; what the agent **concluded** keeps the hedge exactly as it was. A section with
no entries is not rendered, so an agent-written deployment reads as it always did. And a **partial**
block now says so, because a model reading a selection as the whole set turns an absence into a claim.

`OverriddenMemory` gains `author` for the same reason, one level down: precedence is blind to it, so an
agent's own inference at `actor:` outranks an administrator's published policy at `global`. Precedence
is unchanged — but the block now renders a beaten value a person wrote as *"a person stated"* rather
than *"instead has"*, so the model can say which of the two it is departing from.

**Determinism.** The search runs *inside* `memory:digest`, the checkpoint that already holds the whole
digest. A ranking is the most re-derivable thing in this library — the index moves, a neighbour is
written, embeddings are recomputed — so its result is what every replay reads back rather than
something a resuming pod asks again. A run that suspends for an approval and resumes an hour later
rebuilds the identical block. No new checkpoint position; a turn that configures no memory is still
byte-identical to one that never had the option.

`aviary:agent:memory.resolved` gains `pinnedOmitted` and `recalled` — the latter because "this
deployment holds few memories" and "this turn drew twenty out of two thousand" are reported identically
by `offered` alone. `GET /agent/memories` **never** searches: a read-back that ranked would show a
person the slice one question happened to need and hide the rest behind having asked the right thing.
