import { describe, expect, it } from 'vitest';
import { InMemoryScoreStore } from './in-memory-score-store.js';
import type { RunScore } from './score-store.js';

function score(overrides: Partial<RunScore> & { runId: string }): RunScore {
  return {
    threadId: 'thread-1',
    agentName: 'ops',
    scorer: 'run-completion',
    kind: 'rule',
    score: 1,
    reason: 'fine',
    day: '2026-09-01',
    scoredAt: '2026-09-02T00:00:00.000Z',
    ...overrides,
  };
}

describe('InMemoryScoreStore', () => {
  it('reports which of the asked-about runs a scorer already covered', async () => {
    const store = new InMemoryScoreStore();
    await store.recordScores([
      score({ runId: 'run-1' }),
      score({ runId: 'run-2', scorer: 'approval-outcome' }),
      // Same scorer, a run this batch never asked about — it must not leak into the answer.
      score({ runId: 'run-9' }),
    ]);

    expect(await store.scoredRunIds('run-completion', ['run-1', 'run-2', 'run-3'])).toEqual([
      'run-1',
    ]);
  });

  it('keeps both verdicts when a run is re-scored — the history stays auditable', async () => {
    const store = new InMemoryScoreStore();
    await store.recordScores([score({ runId: 'run-1', score: 0 })]);
    await store.recordScores([
      score({ runId: 'run-1', score: 1, scoredAt: '2026-09-03T00:00:00.000Z' }),
    ]);

    expect((await store.listScores({ runId: 'run-1' })).map((row) => row.score)).toEqual([1, 0]);
  });

  it('filters by scorer, agent and inclusive day bounds', async () => {
    const store = new InMemoryScoreStore();
    await store.recordScores([
      score({ runId: 'run-1', day: '2026-08-31' }),
      score({ runId: 'run-2', day: '2026-09-01' }),
      score({ runId: 'run-3', day: '2026-09-02', agentName: 'triage' }),
      score({ runId: 'run-4', day: '2026-09-02', scorer: 'approval-outcome' }),
    ]);

    const rows = await store.listScores({
      scorer: 'run-completion',
      fromDay: '2026-09-01',
      toDay: '2026-09-02',
    });

    expect(rows.map((row) => row.runId).sort()).toEqual(['run-2', 'run-3']);
    expect((await store.listScores({ agentName: 'triage' })).map((row) => row.runId)).toEqual([
      'run-3',
    ]);
  });

  it('does not hand out its internal rows — a caller mutating a result cannot corrupt the store', async () => {
    const store = new InMemoryScoreStore();
    await store.recordScores([score({ runId: 'run-1' })]);

    const [first] = await store.listScores({});
    if (first !== undefined) {
      first.score = 0.123;
    }

    expect((await store.listScores({}))[0]?.score).toBe(1);
  });
});
