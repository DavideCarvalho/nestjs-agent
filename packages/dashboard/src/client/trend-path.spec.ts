import { describe, expect, it } from 'vitest';
import type { UsageTrendPoint } from './agent-client';
import { buildTrendGeometry } from './trend-path';

function point(day: string, costUsd: number, totalTokens: number): UsageTrendPoint {
  return { day, costUsd, totalTokens };
}

describe('buildTrendGeometry', () => {
  it('returns empty geometry for no points', () => {
    const geometry = buildTrendGeometry([], 'costUsd', 100, 40);
    expect(geometry).toEqual({ line: '', area: '', vertices: [], max: 1 });
  });

  it('spreads points across the width and inverts the y-axis', () => {
    const geometry = buildTrendGeometry(
      [point('d1', 0, 0), point('d2', 5, 0), point('d3', 10, 0)],
      'costUsd',
      100,
      40,
    );
    expect(geometry.max).toBe(10);
    expect(geometry.vertices.map((v) => Math.round(v.x))).toEqual([0, 50, 100]);
    // value 0 sits on the baseline (y = height), value max sits at the top (y = 0)
    expect(geometry.vertices[0]?.y).toBe(40);
    expect(geometry.vertices[2]?.y).toBe(0);
    expect(geometry.line.startsWith('M0.00,40.00')).toBe(true);
    expect(geometry.area.endsWith('Z')).toBe(true);
  });

  it('centers a single point', () => {
    const geometry = buildTrendGeometry([point('d1', 3, 0)], 'costUsd', 80, 40);
    expect(geometry.vertices[0]?.x).toBe(40);
  });

  it('plots the requested metric', () => {
    const geometry = buildTrendGeometry(
      [point('d1', 1, 100), point('d2', 1, 300)],
      'totalTokens',
      100,
      40,
    );
    expect(geometry.max).toBe(300);
  });
});
