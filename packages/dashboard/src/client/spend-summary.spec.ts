import { describe, expect, it } from 'vitest';
import type { ModelSpendRow } from './agent-client';
import { donutSegments, summarizeSpend, withShares } from './spend-summary';

function model(over: Partial<ModelSpendRow> = {}): ModelSpendRow {
  return { modelId: 'm', requests: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, ...over };
}

describe('summarizeSpend', () => {
  it('sums cost, tokens and requests across rows', () => {
    const totals = summarizeSpend([
      model({ requests: 2, inputTokens: 10, outputTokens: 5, costUsd: 0.4 }),
      model({ requests: 1, inputTokens: 20, outputTokens: 10, costUsd: 0.6 }),
    ]);
    expect(totals).toEqual({
      costUsd: 1,
      inputTokens: 30,
      outputTokens: 15,
      totalTokens: 45,
      requests: 3,
    });
  });

  it('returns the documented zero value for no rows', () => {
    expect(summarizeSpend([])).toEqual({
      costUsd: 0,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      requests: 0,
    });
  });
});

describe('withShares', () => {
  it('computes cost share and sorts by cost descending', () => {
    const shares = withShares([
      model({ modelId: 'a', costUsd: 1, inputTokens: 5, outputTokens: 5 }),
      model({ modelId: 'b', costUsd: 3, inputTokens: 10, outputTokens: 0 }),
    ]);
    expect(shares.map((s) => s.modelId)).toEqual(['b', 'a']);
    expect(shares[0]?.costShare).toBeCloseTo(0.75);
    expect(shares[1]?.costShare).toBeCloseTo(0.25);
    expect(shares[0]?.totalTokens).toBe(10);
  });

  it('falls back to token share when nothing is priced', () => {
    const shares = withShares([
      model({ modelId: 'a', costUsd: 0, inputTokens: 30, outputTokens: 0 }),
      model({ modelId: 'b', costUsd: 0, inputTokens: 10, outputTokens: 0 }),
    ]);
    // sorted by cost (tie) then tokens desc -> a first
    expect(shares[0]?.modelId).toBe('a');
    expect(shares[0]?.costShare).toBeCloseTo(0.75);
    expect(shares[1]?.costShare).toBeCloseTo(0.25);
  });
});

describe('donutSegments', () => {
  it('lays arcs end-to-end with cumulative offsets and drops zero slices', () => {
    const segments = donutSegments(
      withShares([
        model({ modelId: 'a', costUsd: 3 }),
        model({ modelId: 'b', costUsd: 1 }),
        model({ modelId: 'c', costUsd: 0, inputTokens: 0, outputTokens: 0 }),
      ]),
    );
    expect(segments.map((s) => s.modelId)).toEqual(['a', 'b']);
    expect(segments[0]?.offset).toBeCloseTo(0);
    expect(segments[1]?.offset).toBeCloseTo(0.75);
  });
});
