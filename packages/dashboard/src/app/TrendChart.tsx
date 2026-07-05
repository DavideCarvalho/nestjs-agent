import { useId } from 'react';
import type { UsageTrendPoint } from '../client/agent-client';
import { formatCount, formatUsd } from '../client/format-usd';
import { type TrendMetric, buildTrendGeometry } from '../client/trend-path';

/**
 * Inline-SVG area/line trend for the daily usage series. The geometry (normalized paths + vertices)
 * comes from the pure, unit-tested `buildTrendGeometry`; this component only draws it and the axis
 * labels. Uses a `viewBox` so it scales to its container width.
 */
export function TrendChart({
  points,
  metric,
  height = 120,
}: {
  points: UsageTrendPoint[];
  metric: TrendMetric;
  height?: number;
}) {
  const gradientId = useId();
  const width = 720;
  const pad = 6;
  const geometry = buildTrendGeometry(points, metric, width, height - pad * 2);
  const format = metric === 'costUsd' ? formatUsd : formatCount;
  const first = points[0]?.day ?? '';
  const last = points[points.length - 1]?.day ?? '';

  return (
    <div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        preserveAspectRatio="none"
        className="w-full"
        style={{ height }}
        role="img"
        aria-label="daily usage trend"
      >
        <title>daily usage trend</title>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g transform={`translate(0 ${pad})`}>
          {geometry.area && <path d={geometry.area} fill={`url(#${gradientId})`} />}
          {geometry.line && (
            <path d={geometry.line} fill="none" stroke="var(--accent)" strokeWidth="1.8" />
          )}
          {geometry.vertices.map((vertex) => (
            <circle key={vertex.day} cx={vertex.x} cy={vertex.y} r="2" fill="var(--accent)" />
          ))}
        </g>
      </svg>
      <div className="mono mt-1 flex items-center justify-between text-[10px] text-[var(--muted)]">
        <span>{first}</span>
        <span>peak {format(geometry.max)}</span>
        <span>{last}</span>
      </div>
    </div>
  );
}
