import type { RunTrendPoint } from './agent-client';

/** A plotted day, carrying both series' y-coordinates so a chart can draw them overlaid. */
export interface RunTrendVertex {
  day: string;
  runs: number;
  failed: number;
  x: number;
  runsY: number;
  failedY: number;
}

/** Everything an SVG needs to draw the run/failure trend inside `width`x`height`. */
export interface RunTrendGeometry {
  /** `M..L..` polyline through the `runs` series (empty when there is nothing to plot). */
  runsLine: string;
  /** Closed area path (runs line + baseline) for a filled gradient; empty when nothing to plot. */
  runsArea: string;
  /** `M..L..` polyline through the `failed` series (empty when there is nothing to plot). */
  failedLine: string;
  vertices: RunTrendVertex[];
  /** The shared series max used to normalize the y-axis (never 0 — floored to 1). */
  max: number;
}

/**
 * Project the daily run/failure trend into SVG geometry. Mirrors `buildTrendGeometry`'s x-spread/
 * single-point/empty-series rules, but plots TWO series (`runs`, `failed`) against ONE shared y-axis
 * scale — so the failed line reads as a fraction of the runs line, not its own independent scale.
 * Pure — no DOM.
 */
export function buildRunTrendGeometry(
  points: RunTrendPoint[],
  width: number,
  height: number,
): RunTrendGeometry {
  if (points.length === 0) {
    return { runsLine: '', runsArea: '', failedLine: '', vertices: [], max: 1 };
  }

  const max = Math.max(
    1,
    ...points.map((point) => point.runs),
    ...points.map((point) => point.failed),
  );
  const lastIndex = Math.max(1, points.length - 1);
  const vertices: RunTrendVertex[] = points.map((point, index) => ({
    day: point.day,
    runs: point.runs,
    failed: point.failed,
    x: points.length === 1 ? width / 2 : (index / lastIndex) * width,
    runsY: height - (point.runs / max) * height,
    failedY: height - (point.failed / max) * height,
  }));

  const polyline = (pickY: (vertex: RunTrendVertex) => number): string =>
    vertices
      .map(
        (vertex, index) =>
          `${index === 0 ? 'M' : 'L'}${vertex.x.toFixed(2)},${pickY(vertex).toFixed(2)}`,
      )
      .join(' ');

  const runsLine = polyline((vertex) => vertex.runsY);
  const firstX = vertices[0]?.x ?? 0;
  const lastX = vertices[vertices.length - 1]?.x ?? width;
  const runsArea = `${runsLine} L${lastX.toFixed(2)},${height} L${firstX.toFixed(2)},${height} Z`;

  return {
    runsLine,
    runsArea,
    failedLine: polyline((vertex) => vertex.failedY),
    vertices,
    max,
  };
}
