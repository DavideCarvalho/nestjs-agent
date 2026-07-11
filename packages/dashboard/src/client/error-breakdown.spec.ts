import { describe, expect, it } from 'vitest';
import type { RunErrorBreakdownRow } from './agent-client';
import { errorSegments } from './error-breakdown';

function row(over: Partial<RunErrorBreakdownRow> = {}): RunErrorBreakdownRow {
  return { errorCode: 'CODE', count: 0, ...over };
}

describe('errorSegments', () => {
  it('lays arcs end-to-end by count share, sorted count descending', () => {
    const segments = errorSegments([
      row({ errorCode: 'TIMEOUT', count: 1 }),
      row({ errorCode: 'RATE_LIMIT', count: 3 }),
    ]);
    expect(segments.map((s) => s.modelId)).toEqual(['RATE_LIMIT', 'TIMEOUT']);
    expect(segments[0]?.fraction).toBeCloseTo(0.75);
    expect(segments[0]?.offset).toBeCloseTo(0);
    expect(segments[1]?.fraction).toBeCloseTo(0.25);
    expect(segments[1]?.offset).toBeCloseTo(0.75);
  });

  it('drops zero-count rows', () => {
    const segments = errorSegments([row({ errorCode: 'NONE', count: 0 }), row({ count: 2 })]);
    expect(segments).toHaveLength(1);
  });

  it('returns no segments for an empty breakdown', () => {
    expect(errorSegments([])).toEqual([]);
  });
});
