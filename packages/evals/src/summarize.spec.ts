import { describe, expect, it } from 'vitest';
import type { RunScore } from './score-store.js';
import {
  bucketScoreTrend,
  summarizeByAgent,
  summarizeByScorer,
  worstScoredRuns,
} from './summarize.js';

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

// One agent (`ops`) carries BOTH scorers, so a rollup that groups by agent alone and one that
// groups by (agent, scorer) cannot agree.
const rows: RunScore[] = [
  score({ runId: 'r1', score: 1 }),
  score({ runId: 'r2', score: 0 }),
  score({ runId: 'r3', score: 0.5, day: '2026-09-02' }),
  score({ runId: 'r4', scorer: 'approval-outcome', score: 0, agentName: 'triage' }),
  score({ runId: 'r5', scorer: 'approval-outcome', score: 0.5, agentName: null }),
  score({ runId: 'r6', scorer: 'approval-outcome', score: 0 }),
  score({ runId: 'r7', scorer: 'approval-outcome', score: 0.5 }),
];

describe('summarizeByScorer', () => {
  it('rolls each scorer up with its sample size and puts the worst mean first', () => {
    expect(summarizeByScorer(rows)).toEqual([
      {
        scorer: 'approval-outcome',
        kind: 'rule',
        samples: 4,
        meanScore: 0.25,
        minScore: 0,
        maxScore: 0.5,
      },
      {
        scorer: 'run-completion',
        kind: 'rule',
        samples: 3,
        meanScore: 0.5,
        minScore: 0,
        maxScore: 1,
      },
    ]);
  });

  it('returns nothing for no scores rather than a mean of zero', () => {
    expect(summarizeByScorer([])).toEqual([]);
  });
});

describe('summarizeByAgent', () => {
  it('groups per (agent, scorer) and buckets an unnamed agent under (default)', () => {
    expect(summarizeByAgent(rows)).toEqual([
      { agentName: 'triage', scorer: 'approval-outcome', samples: 1, meanScore: 0 },
      { agentName: 'ops', scorer: 'approval-outcome', samples: 2, meanScore: 0.25 },
      { agentName: '(default)', scorer: 'approval-outcome', samples: 1, meanScore: 0.5 },
      { agentName: 'ops', scorer: 'run-completion', samples: 3, meanScore: 0.5 },
    ]);
  });
});

describe('bucketScoreTrend', () => {
  it('means per day per scorer, ascending by day — the run’s day, not the batch’s', () => {
    expect(bucketScoreTrend(rows)).toEqual([
      { day: '2026-09-01', scorer: 'approval-outcome', samples: 4, meanScore: 0.25 },
      { day: '2026-09-01', scorer: 'run-completion', samples: 2, meanScore: 0.5 },
      { day: '2026-09-02', scorer: 'run-completion', samples: 1, meanScore: 0.5 },
    ]);
  });
});

describe('worstScoredRuns', () => {
  it('puts the lowest scores first and caps the list', () => {
    expect(worstScoredRuns(rows, 2).map((row) => row.runId)).toEqual(['r2', 'r4']);
  });

  it('leaves the caller’s array untouched', () => {
    const input = [score({ runId: 'b', score: 1 }), score({ runId: 'a', score: 0 })];

    worstScoredRuns(input, 2);

    expect(input.map((row) => row.runId)).toEqual(['b', 'a']);
  });
});
