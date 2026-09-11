---
'@dudousxd/nestjs-agent-evals': patch
---

Do not score a run the user cancelled.

`RunCompletionScorer` branched on `running` and `failed` and treated everything else as a settled
answer. A `cancelled` run — someone pressed Stop — therefore scored **0, "the run completed without
answering anything"**, which is the agent being marked down for the control working. Every summary
built over those scores carried it.

A cancelled run now scores `null`, the same as one still in flight: there is no outcome to judge,
because the answer was never allowed to finish. The doc comments on `ScorableRun.status` and
`RunSampleQuery.status`, which still listed three statuses, name the fourth.

**Upgrading.** Scores already persisted for cancelled runs are not rewritten. Re-run the backfill for
the affected range to drop them, or leave them — they are identifiable by `metadata.status`.
