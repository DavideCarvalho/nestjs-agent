import type { DonutSegment } from '../client/spend-summary';

/** A stable, high-contrast palette cycled across donut/legend segments. */
export const SEGMENT_COLORS = [
  '#a78bfa',
  '#22d3ee',
  '#34d399',
  '#fbbf24',
  '#f87171',
  '#60a5fa',
  '#f472b6',
  '#a3e635',
];

export function colorAt(index: number): string {
  return SEGMENT_COLORS[index % SEGMENT_COLORS.length] ?? '#a78bfa';
}

/**
 * Inline-SVG donut. Each segment is an arc drawn with `stroke-dasharray`; the ring is rotated -90deg
 * so the first slice starts at 12 o'clock. `centerLabel`/`centerSub` render inside the hole.
 */
export function Donut({
  segments,
  size = 168,
  thickness = 20,
  centerLabel,
  centerSub,
}: {
  segments: DonutSegment[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerSub?: string;
}) {
  const radius = (size - thickness) / 2;
  const circumference = 2 * Math.PI * radius;
  const center = size / 2;

  return (
    <svg
      width={size}
      height={size}
      viewBox={`0 0 ${size} ${size}`}
      role="img"
      aria-label="spend by model"
    >
      <title>spend by model</title>
      <g transform={`rotate(-90 ${center} ${center})`}>
        <circle
          cx={center}
          cy={center}
          r={radius}
          fill="none"
          stroke="var(--line)"
          strokeWidth={thickness}
        />
        {segments.map((segment, index) => (
          <circle
            key={segment.modelId}
            cx={center}
            cy={center}
            r={radius}
            fill="none"
            stroke={colorAt(index)}
            strokeWidth={thickness}
            strokeDasharray={`${segment.fraction * circumference} ${circumference}`}
            strokeDashoffset={-segment.offset * circumference}
            strokeLinecap="butt"
          />
        ))}
      </g>
      {centerLabel && (
        <text
          x={center}
          y={center - 4}
          textAnchor="middle"
          className="mono tnum"
          fontSize="18"
          fontWeight="600"
          fill="var(--text)"
        >
          {centerLabel}
        </text>
      )}
      {centerSub && (
        <text
          x={center}
          y={center + 14}
          textAnchor="middle"
          className="mono"
          fontSize="10"
          fill="var(--muted)"
        >
          {centerSub}
        </text>
      )}
    </svg>
  );
}
