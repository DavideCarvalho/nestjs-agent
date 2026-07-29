import { describe, expect, it } from 'vitest';
import type { RunTrendPoint, UsageTrendPoint } from './agent-client';
import { summarizeSeries } from './trend-summary';

function usage(day: string, costUsd: number, totalTokens: number): UsageTrendPoint {
  return { day, costUsd, totalTokens };
}

function run(day: string, runs: number, failed: number): RunTrendPoint {
  return { day, runs, failed };
}

describe('summarizeSeries', () => {
  it('returns a neutral summary for an empty series', () => {
    expect(summarizeSeries([], (point: UsageTrendPoint) => point.costUsd)).toEqual({
      first: '',
      last: '',
      peak: 0,
      peakDay: '',
      total: 0,
    });
  });

  it('reports the range, peak and total of the picked metric', () => {
    const points = [
      usage('2026-07-01', 1, 10),
      usage('2026-07-02', 9, 20),
      usage('2026-07-03', 4, 5),
    ];
    expect(summarizeSeries(points, (point) => point.costUsd)).toEqual({
      first: '2026-07-01',
      last: '2026-07-03',
      peak: 9,
      peakDay: '2026-07-02',
      total: 14,
    });
  });

  it('summarizes a different metric off the same points', () => {
    const points = [
      usage('2026-07-01', 1, 10),
      usage('2026-07-02', 9, 20),
      usage('2026-07-03', 4, 5),
    ];
    const summary = summarizeSeries(points, (point) => point.totalTokens);
    expect(summary.peak).toBe(20);
    expect(summary.total).toBe(35);
  });

  it('keeps the FIRST day when several tie for the peak', () => {
    const points = [run('2026-07-01', 5, 0), run('2026-07-02', 5, 1)];
    expect(summarizeSeries(points, (point) => point.runs).peakDay).toBe('2026-07-01');
  });

  it('handles an all-zero series without collapsing the range', () => {
    const points = [run('2026-07-01', 0, 0), run('2026-07-02', 0, 0)];
    expect(summarizeSeries(points, (point) => point.failed)).toEqual({
      first: '2026-07-01',
      last: '2026-07-02',
      peak: 0,
      peakDay: '2026-07-01',
      total: 0,
    });
  });

  it('summarizes a single point as its own range', () => {
    expect(summarizeSeries([usage('2026-07-01', 3, 7)], (point) => point.costUsd)).toEqual({
      first: '2026-07-01',
      last: '2026-07-01',
      peak: 3,
      peakDay: '2026-07-01',
      total: 3,
    });
  });
});
