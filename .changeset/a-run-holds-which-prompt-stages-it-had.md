---
'@dudousxd/nestjs-agent-core': minor
'@dudousxd/nestjs-agent': minor
---

A run now holds which of its optional prompt stages it had, so switching one on cannot move the
positions of a turn already in flight.

`memory:digest`, `retrieve` and `skills:catalog` are checkpoint positions that exist only where a
host wired `memory`, `retrieval` or `skills`. Until now each was decided by reading module config at
replay time. So a turn journaled before a deployment enabled memory — `persist:user`,
`load:thread`, `run:started-at`, `persist:run:start`, `patch:agent:cancellation`, `llm:0`,
`persist:toolcall:<id>`, parked on an action tool's approval — resumed into a body that asks for
`memory:digest` at the position its history spent on `patch:agent:cancellation`. The approval a
person was waiting on died with:

```
non-determinism at <runId>#7: code expects "memory:digest" but history recorded
"patch:agent:cancellation". The workflow changed under an in-flight run
```

The three answers are now read from config ONCE, at a single marker's position, and journaled as
`run:prompt-stages`. Every later replay reads them back, so the enabled set is a fact about the RUN
rather than about the deployment replaying it — in both directions: enabling memory cannot insert a
position into a parked run, and disabling it cannot take one away.

**One marker, not one per stage.** Three separately configurable switches invite three markers, one
guarding each stage's own position. That is wrong, and not marginally: a stage's position is already
occupied on every deployment that has the stage switched on. A journal written with memory enabled
holds `memory:digest` exactly where that marker would sit; `ctx.patched` rewinds there and answers
`false`; the guard then skips a checkpoint the history holds and the run dies a few positions later
with `code expects "stream:step-start:0" but history recorded "memory:digest"` — on every in-flight
run of every host already using the feature, with no config change at all. `agent:dispatched-steps`
can be guarded per-position only because its marker and the behaviour it guards shipped together, so
no journal can hold the new shape without the marker. Memory, retrieval and skills have been
shipping for releases. So the marker records a property of the BODY ("this run journals which stages
it had") and the three independent answers ride in a checkpoint, where they can be stated separately
without one boolean standing in for all of them.

**`quota` shares the hole and is NOT fixed.** `quota:check` is the loop's first position, so the only
marker position that precedes it is the loop's first — which, for a top-level run on a deployment
that has not opted into `dispatchedSteps`, is the workflow's first, and that one is
`agent:dispatched-steps`'s. Two different `patch:` markers at one position is the case `ctx.patched`
refuses outright rather than rewinding, so a quota marker there would convert opting into
`dispatchedSteps` under a parked run from a safe rewind into
`code expects "patch:agent:dispatched-steps" but history recorded "patch:agent:quota"`. Enabling a
quota store under a run in flight therefore still shifts its sequence. A test pins the first position
as the dispatch marker's to spend, so the next reader meets the constraint rather than rediscovering
it.

`pricingStore` (`pricing:list`), `intake` (`intake:ask`/`intake:answers`), `inputProcessors`
(`process:input:<step>`), `outputProcessors` (`process:output:<step>` and the follow-ups gate),
`followUpsCount` (`followups:<step>` and its usage row) and `outputSchema` (`structured:*`) sit on the
same footing and are likewise not covered. They all sit AFTER the marker, so they can join
`run:prompt-stages` later: a field added for one of them reads back `undefined` on a run journaled
before it, which means "fall back to config", leaving that run's exposure unchanged rather than
inverted.

**The marker cannot be retired.** Not while any run journaled by an older release can still resume —
and a turn parked on a human's approval has no upper bound on how long that is. `agent:prompt-stages`
answering `false` is the only thing that keeps such a run deciding its stages the way the body that
wrote its journal did, so removing the guard and keeping the new branch would break exactly the runs
the guard exists for. The same is true of `agent:dispatched-steps`, `agent:selected-history`,
`agent:cancellation` and `agent:parallel-tools`: these markers are permanent fixtures, not a
migration step with an end date.

**What stays module config, deliberately.** The turn's tool list. Whether the model is offered `skill`
or `remember` is uniform across a deployment and is re-derived on whichever worker serves a
dispatched model call, and both handlers already answer a call they have no catalog or digest for as
a tool failure. Only positions are journaled here.

Costs one marker and one checkpoint per run. Nothing about a fresh run's behaviour changes: the
stages it takes are the ones its config names, read one position earlier than before.
