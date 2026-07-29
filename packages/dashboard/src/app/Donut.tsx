import { useMemo } from 'react';
import { Cell, Pie, PieChart, Tooltip } from 'recharts';
import { formatPercent } from '../client/format-usd';
import type { DonutSegment } from '../client/spend-summary';
import { TooltipCard, TooltipRow } from './chart-ui';

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
 * Share donut, drawn with recharts.
 *
 * Fixed-size on purpose — it sits beside a legend list at a size the layout already reserves, so
 * there is nothing for a `ResponsiveContainer` to solve here and a measured container would only add
 * a first-paint flicker. The arcs are laid out clockwise from 12 o'clock (`startAngle` 90 down to
 * -270) to match the order of the legend list next to it.
 *
 * `fraction` is the dataKey rather than `value`: callers have already normalized shares (and dropped
 * zero-share rows), and letting recharts re-derive angles from raw values would disagree with the
 * percentages the legend prints. The unformatted `value` is still carried on each segment so the
 * tooltip can show a real amount, formatted by whatever the caller passes as `formatValue`.
 */
export function Donut({
  segments,
  size = 168,
  thickness = 20,
  centerLabel,
  centerSub,
  label = 'spend by model',
  formatValue = String,
}: {
  segments: DonutSegment[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerSub?: string;
  /** Accessible label for the chart — describes what the segments break down. */
  label?: string;
  /** Formats a segment's raw value for the tooltip (spend is USD, failures are a plain count). */
  formatValue?: (value: number) => string;
}) {
  const outerRadius = size / 2 - 3;
  const byKey = useMemo(
    () => new Map(segments.map((segment) => [segment.modelId, segment])),
    [segments],
  );
  const colorByKey = useMemo(
    () => new Map(segments.map((segment, index) => [segment.modelId, colorAt(index)])),
    [segments],
  );

  return (
    <figure className="relative m-0 shrink-0" style={{ width: size, height: size }}>
      <figcaption className="sr-only">{label}</figcaption>
      {/* The unfilled track, as a plain CSS ring — cheaper and crisper than a background arc. */}
      <div
        className="pointer-events-none absolute inset-[3px] rounded-full"
        style={{ border: `${thickness}px solid var(--line)` }}
      />
      {/*
        The hole's label is painted BEFORE the chart on purpose. Both are positioned, so DOM order
        decides the stacking, and the tooltip lives inside the chart's own wrapper — with the label
        last it covered the tooltip whenever the pointer sat near the middle of a thick arc.
      */}
      {(centerLabel || centerSub) && (
        <div className="pointer-events-none absolute inset-0 grid place-items-center text-center">
          <div>
            {centerLabel && (
              <div className="mono tnum text-lg font-semibold text-[var(--text)]">
                {centerLabel}
              </div>
            )}
            {centerSub && <div className="mono text-[10px] text-[var(--muted)]">{centerSub}</div>}
          </div>
        </div>
      )}
      <div className="relative">
        <PieChart width={size} height={size}>
          <Pie
            data={segments}
            dataKey="fraction"
            nameKey="modelId"
            cx="50%"
            cy="50%"
            innerRadius={outerRadius - thickness}
            outerRadius={outerRadius}
            startAngle={90}
            endAngle={-270}
            paddingAngle={segments.length > 1 ? 1 : 0}
            stroke="none"
            isAnimationActive={false}
            activeShape={{ outerRadius: outerRadius + 3 }}
          >
            {segments.map((segment, index) => (
              <Cell key={segment.modelId} fill={colorAt(index)} />
            ))}
          </Pie>
          <Tooltip
            isAnimationActive={false}
            // The donut is only ~168px across; without this the tooltip is pinned inside that box
            // and a long model id wraps to three lines.
            allowEscapeViewBox={{ x: true, y: true }}
            content={(props) => {
              const name = props.payload?.[0]?.name;
              const segment = typeof name === 'string' ? byKey.get(name) : undefined;
              if (!props.active || !segment) return null;
              return (
                <TooltipCard title={formatPercent(segment.fraction)}>
                  <TooltipRow
                    color={colorByKey.get(segment.modelId) ?? colorAt(0)}
                    label={segment.modelId}
                    value={formatValue(segment.value)}
                  />
                </TooltipCard>
              );
            }}
          />
        </PieChart>
      </div>
    </figure>
  );
}
