import type { UsageTrendPoint } from './agent-client';

/** Which series a trend chart plots. */
export type TrendMetric = 'costUsd' | 'totalTokens';

/** A plotted point in SVG user space. */
export interface TrendVertex {
  day: string;
  value: number;
  x: number;
  y: number;
}

/** Everything an SVG needs to draw a normalized area/line trend inside `width`x`height`. */
export interface TrendGeometry {
  /** `M..L..` polyline through every vertex (empty string when there is nothing to plot). */
  line: string;
  /** Closed area path (line + baseline) for a filled gradient; empty string when nothing to plot. */
  area: string;
  vertices: TrendVertex[];
  /** The series max used to normalize the y-axis (never 0 — floored to 1 so a flat/empty series draws). */
  max: number;
}

/**
 * Project a daily trend series into SVG geometry. The x-axis spreads points evenly across `width`;
 * the y-axis is normalized against the series max (inverted, since SVG y grows downward). A single
 * point renders centered; an empty series yields empty paths and `max: 1`. Pure — no DOM.
 */
export function buildTrendGeometry(
  points: UsageTrendPoint[],
  metric: TrendMetric,
  width: number,
  height: number,
): TrendGeometry {
  if (points.length === 0) return { line: '', area: '', vertices: [], max: 1 };

  const max = Math.max(1, ...points.map((point) => point[metric]));
  const lastIndex = Math.max(1, points.length - 1);
  const vertices: TrendVertex[] = points.map((point, index) => {
    const value = point[metric];
    const x = points.length === 1 ? width / 2 : (index / lastIndex) * width;
    const y = height - (value / max) * height;
    return { day: point.day, value, x, y };
  });

  const line = vertices
    .map(
      (vertex, index) => `${index === 0 ? 'M' : 'L'}${vertex.x.toFixed(2)},${vertex.y.toFixed(2)}`,
    )
    .join(' ');
  const firstX = vertices[0]?.x ?? 0;
  const lastX = vertices[vertices.length - 1]?.x ?? width;
  const area = `${line} L${lastX.toFixed(2)},${height} L${firstX.toFixed(2)},${height} Z`;

  return { line, area, vertices, max };
}
