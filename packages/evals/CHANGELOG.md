# @dudousxd/nestjs-agent-evals

## 0.2.2

### Patch Changes

- fix(deps): update dependency @dudousxd/nestjs-diagnostics to v0.7.1 (#110)

## 0.2.1

### Patch Changes

- [#84](https://github.com/DavideCarvalho/nestjs-agent/pull/84) [`b7d2a75`](https://github.com/DavideCarvalho/nestjs-agent/commit/b7d2a750f32d8c12e8fff9501d5caff7d35f89e9) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Describe `ApprovalPriorQuery.maxRows` as the page-granular bound it is: the walk stops once the bound is reached, after folding in the page that reached it.

## 0.2.0

### Minor Changes

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Add `@dudousxd/nestjs-agent-evals` — answer-quality scoring over stored runs.

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
    to be paid to collect. The score is the fraction of a run's _decided_ actions a human approved. An
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
  `aviary:agent:run.finished` and scores off the diagnostics channel _after_ the run has settled and
  its stream has closed, in a detached promise, with a guarded subscriber and every failure routed to
  `onError`. There is no code path from a scorer back into a turn. It still costs real work per run, so
  the batch stays the default and `sampleRate` sheds load for anything that bills.

### Patch Changes

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

- [#75](https://github.com/DavideCarvalho/nestjs-agent/pull/75) [`d17dbae`](https://github.com/DavideCarvalho/nestjs-agent/commit/d17dbaed49c118f65d5fc9421ccb2677201b5bd4) Thanks [@DavideCarvalho](https://github.com/DavideCarvalho)! - Do not score a run the user cancelled.

  `RunCompletionScorer` branched on `running` and `failed` and treated everything else as a settled
  answer. A `cancelled` run — someone pressed Stop — therefore scored **0, "the run completed without
  answering anything"**, which is the agent being marked down for the control working. Every summary
  built over those scores carried it.

  A cancelled run now scores `null`, the same as one still in flight: there is no outcome to judge,
  because the answer was never allowed to finish. The doc comments on `ScorableRun.status` and
  `RunSampleQuery.status`, which still listed three statuses, name the fourth.

  **Upgrading.** Scores already persisted for cancelled runs are not rewritten. Re-run the backfill for
  the affected range to drop them, or leave them — they are identifiable by `metadata.status`.
