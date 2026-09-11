# `@dudousxd/nestjs-agent-evals`

> 🪺 Part of the [Aviary](https://davidecarvalho.github.io/aviary) · answer-quality scoring for [`@dudousxd/nestjs-agent`](https://www.npmjs.com/package/@dudousxd/nestjs-agent).

The library already tells you what a turn **cost** and whether it **finished**. This tells you
whether it was any **good** — as a number, with a reason, over time.

Scoring is **offline-first**: a `Scorer` reads a run the agent already persisted (the run row, the
transcript, the tool calls and their human approve/reject outcomes), so nothing sits inside a turn
adding latency or cost to every message a user sends.

## Install

```bash
pnpm add @dudousxd/nestjs-agent-evals @dudousxd/nestjs-agent-core
```

## Run a backfill

```ts
import {
  ApprovalOutcomeScorer,
  ApprovalRiskScorer,
  GovernanceRunSampleSource,
  InMemoryScoreStore,
  RunCompletionScorer,
  loadApprovalPrior,
  runEvaluation,
  summarizeByScorer,
} from '@dudousxd/nestjs-agent-evals';

const source = new GovernanceRunSampleSource(governanceQueries, agentStore);
const scoreStore = new InMemoryScoreStore(); // or your own ScoreStore adapter

const summary = await runEvaluation({
  source,
  scorers: [
    new RunCompletionScorer(),
    new ApprovalOutcomeScorer(),
    new ApprovalRiskScorer(await loadApprovalPrior(governanceQueries)),
  ],
  store: scoreStore,
  query: { limit: 500, fromDay: '2026-09-01', toDay: '2026-09-07' },
});

summarizeByScorer(await scoreStore.listScores({})); // worst mean first
```

Re-running the same query costs nothing for the runs it already covered — `runEvaluation` skips a
`(run, scorer)` pair the store has seen, so a backfill is resumable and a model-graded scorer is
never billed twice. Pass `rescore: true` to override.

## The built-in scorers

| Scorer | Family | What it reads | `null` when |
|---|---|---|---|
| `RunCompletionScorer` | `rule` | Run status + answer text + tool-call outcomes. A run that settles `completed` after answering nothing scores **0** — the reliability metric calls that a success. | The run is still in flight. |
| `ApprovalOutcomeScorer` | `rule` | **HITL decisions.** The fraction of the run's decided `action` tool calls a human approved. | No action was proposed, or none has been decided yet. |
| `ApprovalRiskScorer` | `statistical` | The same corpus as a **prior**: how likely a human is to reject what this run proposed, before anyone looks. A run scores as its riskiest action. | The run proposed no action. |
| `AnswerRelevancyScorer` | `model` | LLM-as-judge over question + answer, via any `ModelProvider`. | There is no question or no answer to compare. |

### Why the HITL scorers are the interesting ones

Every rejection an operator clicks is a **negative quality label a human produced for free**, in the
words of the domain, at the moment it mattered. The library already collects them — human-in-the-loop
approval is a feature, not an evaluation exercise — and no amount of LLM-judging buys a signal of
that quality. `ApprovalOutcomeScorer` reads the verdicts back; `ApprovalRiskScorer` turns them into a
prediction so an approvals inbox can be drained riskiest-first.

`null`, not `1`, is what a scorer returns for a run it has nothing to say about. Most runs are
read-only and carry no human verdict; scoring those as perfect would bury the ones that do under an
average of ~1.

## Live scoring (opt-in)

```ts
const live = attachLiveScoring({ source, scorers: [new RunCompletionScorer()], store: scoreStore });
// later: live.dispose()
```

Subscribes to `aviary:agent:run.finished` and scores off the diagnostics channel — **after** the run
has settled and its stream has closed, in a detached promise, with every failure routed to
`onError`. There is no code path from a scorer back into a turn. It still costs real work per run,
so keep the batch as the default path, prefer the `rule`/`statistical` scorers here, and turn
`sampleRate` down for anything that bills.

## Writing a scorer

```ts
import type { ScorableRun, ScoreResult, Scorer } from '@dudousxd/nestjs-agent-evals';

export class NoApologiesScorer implements Scorer {
  readonly name = 'no-apologies';
  readonly kind = 'rule' as const;

  async score(run: ScorableRun): Promise<ScoreResult | null> {
    if (run.output === '') return null;
    const apologised = /\b(sorry|i apologi[sz]e)\b/i.test(run.output);
    return { score: apologised ? 0 : 1, reason: apologised ? 'the answer apologised' : 'no apology' };
  }
}
```

For a model-graded one, `discardingSink()` and `parseJudgeVerdict()` are exported — a judge call has
no live stream to join, and a judge that replies with prose should **throw**, not score 0 (the batch
records it as a failure, so a broken evaluation never reads as a bad agent).

## Persistence

`ScoreStore` is the write/read seam (`recordScores` / `scoredRunIds` / `listScores`). `InMemoryScoreStore`
ships here for tests and the offline demo; a real adapter is a table with `(runId, scorer, kind,
score, reason, metadata, day, scoredAt)` — the same shape as the agent's own ledger tables, kept
apart from them so the agent's schema does not grow a column per scorer.

`day` is the **run's** day, never the batch's: a trend must move when the agent's quality moves, not
when someone re-ran a backfill over last month.

## License

MIT © Davide Carvalho
