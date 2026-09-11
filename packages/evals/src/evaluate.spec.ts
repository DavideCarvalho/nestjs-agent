import { describe, expect, it } from 'vitest';
import { runEvaluation } from './evaluate.js';
import { InMemoryScoreStore } from './in-memory-score-store.js';
import { StaticRunSampleSource } from './sample-source.js';
import { RunCompletionScorer } from './scorers/run-completion.scorer.js';
import type { ScorableRun, ScoreResult, Scorer } from './types.js';

function run(overrides: Partial<ScorableRun> & { runId: string }): ScorableRun {
  return {
    threadId: 'thread-1',
    actorRef: 'alice',
    agentName: 'ops',
    status: 'completed',
    input: 'how many pods are down?',
    output: 'two',
    toolCalls: [],
    durationMs: 10,
    errorCode: null,
    startedAt: '2026-09-01T10:00:00.000Z',
    ...overrides,
  };
}

/** A scorer whose verdict (or explosion) each test dictates, so the runner is what is under test. */
class StubScorer implements Scorer {
  calls: string[] = [];
  constructor(
    readonly name: string,
    private readonly verdict: (run: ScorableRun) => ScoreResult | null,
    readonly kind: Scorer['kind'] = 'rule',
  ) {}
  async score(sample: ScorableRun): Promise<ScoreResult | null> {
    this.calls.push(sample.runId);
    return this.verdict(sample);
  }
}

describe('runEvaluation', () => {
  it('scores every run with every scorer and persists the verdicts', async () => {
    const store = new InMemoryScoreStore();

    const summary = await runEvaluation({
      source: new StaticRunSampleSource([run({ runId: 'r1' }), run({ runId: 'r2' })]),
      scorers: [new RunCompletionScorer()],
      store,
      query: { limit: 10 },
    });

    expect(summary).toMatchObject({
      runsRead: 2,
      runsScored: 2,
      pairsSkipped: 0,
      scoresRecorded: 2,
      failures: [],
    });
    expect((await store.listScores({})).map((row) => row.runId).sort()).toEqual(['r1', 'r2']);
  });

  it('records a scorer failure and keeps going instead of losing the rest of the batch', async () => {
    const store = new InMemoryScoreStore();
    // r2 sorts first (newest-first, runId desc on a tied timestamp), so the batch trips on its
    // very first run — the case where "keeps going" is the whole claim.
    const exploding = new StubScorer('judge', (sample) => {
      if (sample.runId === 'r2') {
        throw new Error('judge returned prose');
      }
      return { score: 1, reason: 'ok' };
    });

    const summary = await runEvaluation({
      source: new StaticRunSampleSource([run({ runId: 'r1' }), run({ runId: 'r2' })]),
      scorers: [exploding],
      store,
      query: { limit: 10 },
    });

    expect(summary.failures).toEqual([
      { runId: 'r2', scorer: 'judge', message: 'judge returned prose' },
    ]);
    expect(summary.scoresRecorded).toBe(1);
    expect(exploding.calls).toEqual(['r2', 'r1']);
  });

  it('persists nothing for a scorer that declined, and does not count the run as scored', async () => {
    const store = new InMemoryScoreStore();

    const summary = await runEvaluation({
      source: new StaticRunSampleSource([run({ runId: 'r1' })]),
      scorers: [new StubScorer('abstains', () => null)],
      store,
      query: { limit: 10 },
    });

    expect(summary).toMatchObject({ runsRead: 1, runsScored: 0, scoresRecorded: 0 });
    expect(await store.listScores({})).toEqual([]);
  });

  it('skips a run a scorer already covered, so a resumed backfill re-bills nothing', async () => {
    const store = new InMemoryScoreStore();
    const source = new StaticRunSampleSource([run({ runId: 'r1' }), run({ runId: 'r2' })]);
    const scorer = new StubScorer('judge', () => ({ score: 1, reason: 'ok' }), 'model');
    await runEvaluation({ source, scorers: [scorer], store, query: { limit: 1 } });

    const second = await runEvaluation({ source, scorers: [scorer], store, query: { limit: 10 } });

    expect(second).toMatchObject({ runsRead: 2, pairsSkipped: 1, scoresRecorded: 1 });
    // The first batch's `limit: 1` reached only r2 (newest first, a tied timestamp broken by
    // runId desc), so the second batch re-visits r1 alone.
    expect(scorer.calls).toEqual(['r2', 'r1']);
  });

  it('re-scores an already-covered run when asked to', async () => {
    const store = new InMemoryScoreStore();
    const source = new StaticRunSampleSource([run({ runId: 'r1' })]);
    const scorer = new StubScorer('judge', () => ({ score: 1, reason: 'ok' }));
    await runEvaluation({ source, scorers: [scorer], store, query: { limit: 10 } });

    const second = await runEvaluation({
      source,
      scorers: [scorer],
      store,
      query: { limit: 10 },
      rescore: true,
    });

    expect(second).toMatchObject({ pairsSkipped: 0, scoresRecorded: 1 });
  });

  it('stamps the score with the RUN’s day and the scorer’s kind, not the batch’s day', async () => {
    const store = new InMemoryScoreStore();

    await runEvaluation({
      source: new StaticRunSampleSource([
        run({ runId: 'r1', startedAt: '2026-08-14T23:59:59.000Z' }),
      ]),
      scorers: [new StubScorer('judge', () => ({ score: 0.5, reason: 'meh' }), 'model')],
      store,
      query: { limit: 10 },
      now: () => new Date('2026-09-30T12:00:00.000Z'),
    });

    expect((await store.listScores({}))[0]).toMatchObject({
      day: '2026-08-14',
      scoredAt: '2026-09-30T12:00:00.000Z',
      kind: 'model',
    });
  });

  it('passes the query through to the source', async () => {
    const store = new InMemoryScoreStore();

    const summary = await runEvaluation({
      source: new StaticRunSampleSource([
        run({ runId: 'r1', agentName: 'ops' }),
        run({ runId: 'r2', agentName: 'triage' }),
      ]),
      scorers: [new RunCompletionScorer()],
      store,
      query: { limit: 10, agentName: 'triage' },
    });

    expect(summary.runsRead).toBe(1);
    expect((await store.listScores({}))[0]?.runId).toBe('r2');
  });
});
