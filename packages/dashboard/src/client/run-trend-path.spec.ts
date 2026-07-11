import { describe, expect, it } from 'vitest';
import type { RunTrendPoint } from './agent-client';
import { buildRunTrendGeometry } from './run-trend-path';

function point(day: string, runs: number, failed: number): RunTrendPoint {
  return { day, runs, failed };
}

describe('buildRunTrendGeometry', () => {
  it('returns empty geometry for no points', () => {
    const geometry = buildRunTrendGeometry([], 100, 40);
    expect(geometry).toEqual({
      runsLine: '',
      runsArea: '',
      failedLine: '',
      vertices: [],
      max: 1,
    });
  });

  it('spreads points across the width and inverts the y-axis', () => {
    const geometry = buildRunTrendGeometry(
      [point('d1', 0, 0), point('d2', 5, 0), point('d3', 10, 0)],
      100,
      40,
    );
    expect(geometry.max).toBe(10);
    expect(geometry.vertices.map((v) => Math.round(v.x))).toEqual([0, 50, 100]);
    expect(geometry.vertices[0]?.runsY).toBe(40);
    expect(geometry.vertices[2]?.runsY).toBe(0);
    expect(geometry.runsLine.startsWith('M0.00,40.00')).toBe(true);
    expect(geometry.runsArea.endsWith('Z')).toBe(true);
  });

  it('shares ONE max across both series', () => {
    const geometry = buildRunTrendGeometry([point('d1', 10, 4)], 100, 40);
    expect(geometry.max).toBe(10);
    // failed=4 of max=10 sits 60% down from the top
    expect(geometry.vertices[0]?.failedY).toBeCloseTo(24);
  });

  it('centers a single point', () => {
    const geometry = buildRunTrendGeometry([point('d1', 3, 1)], 80, 40);
    expect(geometry.vertices[0]?.x).toBe(40);
  });
});
