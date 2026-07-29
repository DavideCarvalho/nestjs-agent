/**
 * Summary statistics for a daily trend series. Pure; unit-tested.
 *
 * This replaced `trend-path.ts` / `run-trend-path.ts`, which existed only to project a series into
 * SVG path strings. Recharts owns that projection now, so the geometry went away — but the numbers a
 * reader still wants at a glance (the range it covers, where it peaked) are not something a chart
 * library computes for you, and they stay worth testing.
 */

/** Which series the daily usage chart plots. */
export type TrendMetric = 'costUsd' | 'totalTokens';

/** The at-a-glance facts a trend caption states, so the chart is legible without hovering it. */
export interface SeriesSummary {
  /** First day in the series, or `''` when there is nothing to plot. */
  first: string;
  /** Last day in the series, or `''` when there is nothing to plot. */
  last: string;
  /** Highest value in the series (0 for an empty series). */
  peak: number;
  /** The day the peak occurred on — the FIRST such day when several tie. `''` when empty. */
  peakDay: string;
  /** Sum across the series. */
  total: number;
}

/**
 * Summarize a day-keyed series. `value` picks the number to summarize, so the same function serves
 * the cost/token trend and either leg of the run/failure trend. Assumes the series is already in
 * chronological order — the read-model returns it that way, and re-sorting here would quietly
 * disagree with the order the chart draws.
 */
export function summarizeSeries<T extends { day: string }>(
  points: readonly T[],
  value: (point: T) => number,
): SeriesSummary {
  const first = points[0];
  const last = points[points.length - 1];
  if (!first || !last) return { first: '', last: '', peak: 0, peakDay: '', total: 0 };

  let peak = Number.NEGATIVE_INFINITY;
  let peakDay = first.day;
  let total = 0;
  for (const point of points) {
    const current = value(point);
    total += current;
    if (current > peak) {
      peak = current;
      peakDay = point.day;
    }
  }

  return { first: first.day, last: last.day, peak, peakDay, total };
}
