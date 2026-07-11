import { useId } from 'react';
import type { RunTrendPoint } from '../client/agent-client';
import { formatCount } from '../client/format-usd';
import { buildRunTrendGeometry } from '../client/run-trend-path';

/**
 * Inline-SVG run/failure trend: two overlaid series (total runs, failed runs) on ONE y-axis scale.
 * Mirrors `TrendChart`'s geometry-from-pure-fn / viewBox-scaling pattern; the `runs` line gets the
 * shared area gradient, `failed` draws as a plain stroke in the `--bad` hue.
 */
export function RunTrendChart({
  points,
  height = 120,
}: {
  points: RunTrendPoint[];
  height?: number;
}) {
  const gradientId = useId();
  const width = 720;
  const pad = 6;
  const geometry = buildRunTrendGeometry(points, width, height - pad * 2);
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
        aria-label="daily run and failure trend"
      >
        <title>daily run and failure trend</title>
        <defs>
          <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.35" />
            <stop offset="100%" stopColor="var(--accent)" stopOpacity="0" />
          </linearGradient>
        </defs>
        <g transform={`translate(0 ${pad})`}>
          {geometry.runsArea && <path d={geometry.runsArea} fill={`url(#${gradientId})`} />}
          {geometry.runsLine && (
            <path d={geometry.runsLine} fill="none" stroke="var(--accent)" strokeWidth="1.8" />
          )}
          {geometry.failedLine && (
            <path d={geometry.failedLine} fill="none" stroke="var(--bad)" strokeWidth="1.8" />
          )}
          {geometry.vertices.map((vertex) => (
            <circle
              key={`runs-${vertex.day}`}
              cx={vertex.x}
              cy={vertex.runsY}
              r="2"
              fill="var(--accent)"
            />
          ))}
          {geometry.vertices.map((vertex) => (
            <circle
              key={`failed-${vertex.day}`}
              cx={vertex.x}
              cy={vertex.failedY}
              r="2"
              fill="var(--bad)"
            />
          ))}
        </g>
      </svg>
      <div className="mono mt-1 flex items-center justify-between text-[10px] text-[var(--muted)]">
        <span className="flex items-center gap-3">
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm" style={{ background: 'var(--accent)' }} />
            runs
          </span>
          <span className="flex items-center gap-1">
            <span className="h-2 w-2 rounded-sm" style={{ background: 'var(--bad)' }} />
            failed
          </span>
        </span>
        <span>
          peak {formatCount(geometry.max)} · {first} – {last}
        </span>
      </div>
    </div>
  );
}
