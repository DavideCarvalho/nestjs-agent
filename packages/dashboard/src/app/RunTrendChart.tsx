import { useId, useMemo } from 'react';
import {
  Area,
  CartesianGrid,
  ComposedChart,
  Line,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import type { RunTrendPoint } from '../client/agent-client';
import { formatDayLabel, formatDayTick } from '../client/format-day';
import { formatCount, formatPercent } from '../client/format-usd';
import { summarizeSeries } from '../client/trend-summary';
import {
  AXIS_LINE,
  AXIS_TICK,
  CURSOR,
  ChartCaption,
  GRID,
  TooltipCard,
  TooltipRow,
} from './chart-ui';

/**
 * Daily runs vs. failed runs, drawn with recharts.
 *
 * Two series on ONE y-axis, as before — the point of this chart is that the failure line reads as a
 * fraction of the run line, and giving `failed` its own scale would make a handful of failures look
 * like an outage. `runs` keeps the filled accent area; `failed` is a plain stroke in the `--bad` hue.
 *
 * The tooltip is where this earns its keep: it shows both series for the hovered day plus the failure
 * rate, which previously could only be eyeballed from the gap between two lines.
 */
export function RunTrendChart({
  points,
  height = 200,
}: {
  points: RunTrendPoint[];
  height?: number;
}) {
  const gradientId = useId();
  const byDay = useMemo(() => new Map(points.map((point) => [point.day, point])), [points]);
  const runs = useMemo(() => summarizeSeries(points, (point) => point.runs), [points]);
  const failed = useMemo(() => summarizeSeries(points, (point) => point.failed), [points]);

  return (
    <figure className="m-0">
      <div className="w-full" style={{ height }}>
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={points} margin={{ top: 8, right: 18, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id={gradientId} x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="var(--accent)" stopOpacity={0.35} />
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
              tickFormatter={formatCount}
              tick={AXIS_TICK}
              axisLine={false}
              tickLine={false}
              width={44}
              allowDecimals={false}
            />
            <Tooltip
              cursor={CURSOR}
              isAnimationActive={false}
              content={(props) => {
                const day = typeof props.label === 'string' ? props.label : null;
                const point = day ? byDay.get(day) : undefined;
                if (!props.active || !point) return null;
                const rate = point.runs > 0 ? point.failed / point.runs : 0;
                return (
                  <TooltipCard title={formatDayLabel(point.day)}>
                    <TooltipRow
                      color="var(--accent)"
                      label="runs"
                      value={formatCount(point.runs)}
                    />
                    <TooltipRow
                      color="var(--bad)"
                      label="failed"
                      value={`${formatCount(point.failed)} · ${formatPercent(rate)}`}
                    />
                  </TooltipCard>
                );
              }}
            />
            <Area
              type="monotone"
              dataKey="runs"
              name="runs"
              stroke="var(--accent)"
              strokeWidth={1.8}
              fill={`url(#${gradientId})`}
              dot={false}
              activeDot={{ r: 3.5, strokeWidth: 0, fill: 'var(--accent)' }}
              isAnimationActive={false}
            />
            <Line
              type="monotone"
              dataKey="failed"
              name="failed"
              stroke="var(--bad)"
              strokeWidth={1.8}
              dot={false}
              activeDot={{ r: 3.5, strokeWidth: 0, fill: 'var(--bad)' }}
              isAnimationActive={false}
            />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <ChartCaption>
        {/*
          The legend is ours rather than recharts' `<Legend>`: v3 omits `payload` from the legend's
          props, so the only way to state that `runs` comes before `failed` is to draw the swatches
          here — which also keeps them in the same caption line as the range and peak.
        */}
        <span className="flex items-center gap-3">
          <SeriesKey color="var(--accent)" label="runs" />
          <SeriesKey color="var(--bad)" label="failed" />
        </span>
        <span>
          {formatDayLabel(runs.first)} – {formatDayLabel(runs.last)}
        </span>
        <span>
          {`peak ${formatCount(runs.peak)} runs on ${formatDayTick(runs.peakDay)} · ${formatCount(failed.total)} failed overall`}
        </span>
      </ChartCaption>
    </figure>
  );
}

/** One swatch + name in the chart's caption-level legend. */
function SeriesKey({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-sm" style={{ background: color }} />
      {label}
    </span>
  );
}
