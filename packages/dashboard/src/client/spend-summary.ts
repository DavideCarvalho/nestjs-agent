import type { ModelSpendRow } from './agent-client';

/** Headline totals for a range, summed across every model row. */
export interface SpendTotals {
  costUsd: number;
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  requests: number;
}

/** A model row enriched with its share (0..1) of total cost — for share bars / donut segments. */
export interface ModelSpendShare extends ModelSpendRow {
  totalTokens: number;
  /** Fraction of total cost (0..1). 0 when there is no cost anywhere (falls back to token share). */
  costShare: number;
}

/** One donut arc segment: a normalized 0..1 slice with its cumulative offset (also 0..1). */
export interface DonutSegment {
  modelId: string;
  value: number;
  fraction: number;
  offset: number;
}

/** Sum the by-model rows into the headline totals. */
export function summarizeSpend(rows: ModelSpendRow[]): SpendTotals {
  const totals: SpendTotals = {
    costUsd: 0,
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
    requests: 0,
  };
  for (const row of rows) {
    totals.costUsd += row.costUsd;
    totals.inputTokens += row.inputTokens;
    totals.outputTokens += row.outputTokens;
    totals.requests += row.requests;
  }
  totals.totalTokens = totals.inputTokens + totals.outputTokens;
  return totals;
}

/**
 * Enrich each model row with its cost share, sorted by cost descending. When nothing has a cost
 * (every model unpriced) the share falls back to token share so the bars/donut still convey usage
 * mix instead of collapsing to zero.
 */
export function withShares(rows: ModelSpendRow[]): ModelSpendShare[] {
  const totalCost = rows.reduce((sum, row) => sum + row.costUsd, 0);
  const totalTokens = rows.reduce((sum, row) => sum + row.inputTokens + row.outputTokens, 0);
  const denomCost = totalCost > 0 ? totalCost : 0;
  return rows
    .map((row) => {
      const rowTokens = row.inputTokens + row.outputTokens;
      const costShare =
        denomCost > 0 ? row.costUsd / denomCost : totalTokens > 0 ? rowTokens / totalTokens : 0;
      return { ...row, totalTokens: rowTokens, costShare };
    })
    .sort((a, b) => b.costUsd - a.costUsd || b.totalTokens - a.totalTokens);
}

/**
 * Build donut segments from the shared rows: each fraction is the row's `costShare`, and `offset` is
 * the running cumulative fraction (so an SVG can lay arcs end-to-end). Zero-share rows are dropped so
 * the donut has no invisible slices.
 */
export function donutSegments(rows: ModelSpendShare[]): DonutSegment[] {
  const segments: DonutSegment[] = [];
  let offset = 0;
  for (const row of rows) {
    if (row.costShare <= 0) continue;
    segments.push({
      modelId: row.modelId,
      value: row.costUsd,
      fraction: row.costShare,
      offset,
    });
    offset += row.costShare;
  }
  return segments;
}
