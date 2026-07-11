import type { RunErrorBreakdownRow } from './agent-client';
import type { DonutSegment } from './spend-summary';

/**
 * Build donut segments from an error-code breakdown, reusing the spend donut's `DonutSegment` shape
 * (its `modelId` field carries the `errorCode` here — the `Donut` component only ever treats it as an
 * opaque segment key/label). Sorted by count descending; zero-count rows are dropped.
 */
export function errorSegments(rows: RunErrorBreakdownRow[]): DonutSegment[] {
  const total = rows.reduce((sum, row) => sum + row.count, 0);
  const sorted = [...rows].sort((a, b) => b.count - a.count);
  const segments: DonutSegment[] = [];
  let offset = 0;
  for (const row of sorted) {
    if (total <= 0 || row.count <= 0) continue;
    const fraction = row.count / total;
    segments.push({ modelId: row.errorCode, value: row.count, fraction, offset });
    offset += fraction;
  }
  return segments;
}
