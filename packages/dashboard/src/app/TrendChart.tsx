import { useId, useMemo } from 'react';
import {
  Area,
  AreaChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { UsageTrendPoint } from '../client/agent-client';
import { formatDayLabel, formatDayTick } from '../client/format-day';
import { formatCount, formatUsd } from '../client/format-usd';
import { type TrendMetric, summarizeSeries } from '../client/trend-summary';
import {
  AXIS_LINE,
  AXIS_TICK,
  CURSOR,
  ChartCaption,
  GRID,
  TooltipCard,
  TooltipRow,
} from './chart-ui';

export type { TrendMetric };

const METRIC_LABEL: Record<TrendMetric, string> = { costUsd: 'Cost', totalTokens: 'Tokens' };

/**
 * Daily usage trend, drawn with recharts.
 *
 * This used to be a hand-rolled `<svg>` fed by a pure path builder. It drew fine and read wrong: no
 * hover, no axes, and `preserveAspectRatio="none"` on a fixed 720-wide viewBox — which stretched the
 * geometry horizontally at every other container width, distorting stroke weights and dot radii with
 * it. `ResponsiveContainer` re-measures rather than scaling, so the chart is correct at any width,
 * and the tooltip finally lets a reader take an actual number off the curve.
 *
 * Recharts enables its accessibility layer by default in v3, so the plot is focusable and arrow keys
 * walk the series with the tooltip following. The `<figcaption>` carries the same headline facts for
 * a reader who never touches it.
 */
export function TrendChart({
  points,
  metric,
  height = 200,
}: {
  points: UsageTrendPoint[];
  metric: TrendMetric;
  height?: number;
}) {
  const gradientId = useId();
  const format = metric === 'costUsd' ? formatUsd : formatCount;
  const label = METRIC_LABEL[metric];
  const byDay = useMemo(() => new Map(points.map((point) => [point.day, point])), [points]);
  const summary = useMemo(
    () => summarizeSeries(points, (point) => point[metric]),
    [points, metric],
  );

  return (
    <figure className="m-0">
      <div className="w-full" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <AreaChart data={points} margin={{ top: 8, right: 18, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.38} />
                <stop offset="100%" stopColor="var(--accent)" stopOpacity={0} />
              </linearGradient>
            </defs>
            <CartesianGrid {...GRID} />
            <XAxis
              dataKey="day"
              tickFormatter={formatDayTick}
              tick={AXIS_TICK}
              axisLine={AXIS_LINE}
              tickLine={false}
              minTickGap={28}
            />
            <YAxis
              tickFormatter={format}
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={56}
            />
            <Tooltip
              cursor={CURSOR}
              isAnimationActive={false}
              content={(props) => {
                const day = typeof props.label === 'string' ? props.label : null;
                const point = day ? byDay.get(day) : undefined;
                if (!props.active || !point) return null;
                return (
                  <TooltipCard title={formatDayLabel(point.day)}>
                    <TooltipRow color="var(--accent)" label={label} value={format(point[metric])} />
                  </TooltipCard>
                );
              }}
            />
            <Area
              type="monotone"
              dataKey={metric}
              name={label}
              stroke="var(--accent)"
              strokeWidth={1.8}
              fill={`url(#${gradientId})`}
              dot={false}
              activeDot={{ r: 3.5, strokeWidth: 0, fill: 'var(--accent)' }}
              isAnimationActive={false}
            />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <ChartCaption>
        <span>
          {formatDayLabel(summary.first)} – {formatDayLabel(summary.last)}
        </span>
        <span>
          peak {format(summary.peak)} on {formatDayTick(summary.peakDay)}
        </span>
      </ChartCaption>
    </figure>
  );
}
