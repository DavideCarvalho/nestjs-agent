---
'@dudousxd/nestjs-agent-evals': minor
---

Add `@dudousxd/nestjs-agent-evals` — answer-quality scoring over stored runs.

The library could already tell you what a turn cost and whether it finished; it could not tell you
whether it was any good. This adds a `Scorer` SPI (a run in, a `0..1` score plus the sentence that
justifies it out), a resumable batch runner over persisted runs, a `ScoreStore` for the verdicts, and
pure aggregation helpers (`summarizeByScorer` / `summarizeByAgent` / `bucketScoreTrend` /
`worstScoredRuns`) that mirror the governance read-model's arithmetic so a dashboard and a CI gate
can never disagree about whether quality moved.

**Offline-first, on purpose.** Scoring reads what the agent already persisted — the run row, the
transcript, the tool calls and their outcomes — via `GovernanceRunSampleSource` over the existing
`AgentGovernanceQueries` + `AgentStore` SPIs, so it works against the MikroORM, Drizzle and in-memory
stores unchanged and adds no read tables of its own. Nothing runs inside a turn: an inline judge
would double the latency and the bill of every message a user sends. `runEvaluation` skips a
`(run, scorer)` pair the store has already seen, so an interrupted backfill restarted with the same
query re-bills nothing.

**Four built-in scorers, one per thing this library actually knows:**

- `RunCompletionScorer` (`rule`) — did the turn deliver? A run that settles `completed` after
  answering nothing scores 0, which is exactly what the governance success rate calls a success; an
  answer written while a tool was failing scores 0.5.
- `ApprovalOutcomeScorer` (`rule`) — **every HITL rejection is a negative quality label a human
  produced for free.** The library already stops an `action` tool and asks a person whether it should
  run; that answer is recorded on the tool call and is the only ground truth in the system nobody had
  to be paid to collect. The score is the fraction of a run's *decided* actions a human approved. An
  approved action that then crashed counts as approved — the human still said yes.
- `ApprovalRiskScorer` (`statistical`) — the same corpus as a prediction: a Beta(1,1)-smoothed
  per-tool approval rate, so an unseen tool sits at exactly 0.5 and a 1-of-1 rejection never reads as
  certainty. A run scores as its riskiest proposed action, not the average, so an approvals inbox can
  be drained worst-first.
- `AnswerRelevancyScorer` (`model`) — LLM-as-judge over any `ModelProvider`, with `discardingSink()`
  and `parseJudgeVerdict()` exported for writing your own.

A scorer returns `null` — not `1` — for a run it has nothing to say about. Most runs are read-only
and carry no human verdict; counting those as perfect would bury the runs that do carry one under an
average of ~1. A scorer that throws is collected as a per-run failure and the batch carries on: a
judge that replied with prose is a broken evaluation, and recording it as a 0 would put the blame on
the agent.

**Live scoring is opt-in and cannot fail a turn.** `attachLiveScoring` subscribes to
`aviary:agent:run.finished` and scores off the diagnostics channel *after* the run has settled and
its stream has closed, in a detached promise, with a guarded subscriber and every failure routed to
`onError`. There is no code path from a scorer back into a turn. It still costs real work per run, so
the batch stays the default and `sampleRate` sheds load for anything that bills.
