import { useMemo } from 'react';
import { TimeSeriesChart } from '../aviary-kit/charts/time-series-chart';
import type { UsageTrendPoint } from '../client/agent-client';
import { formatDayLabel, formatDayTick } from '../client/format-day';
import { formatCount, formatUsd } from '../client/format-usd';
import { type TrendMetric, summarizeSeries } from '../client/trend-summary';
import { ChartCaption } from './chart-ui';

export type { TrendMetric };

const METRIC_LABEL: Record<TrendMetric, string> = { costUsd: 'Cost', totalTokens: 'Tokens' };

const day = (point: UsageTrendPoint) => point.day;

/**
 * Daily usage trend (cost or tokens) as the console kit's area chart (TanStack Charts). Hovering or
 * focusing a day (Tab, then the arrow keys) shows its value in the kit tooltip, formatted as USD or
 * a token count; the chart re-measures with its container, so it reads right at any width.
 *
 * The `<figcaption>` states the range and the peak, so the chart is legible without hovering it.
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
  const cost = metric === 'costUsd';
  const format = cost ? formatUsd : formatCount;
  const series = useMemo(
    () => [
      {
        key: metric,
        label: METRIC_LABEL[metric],
        value: (point: UsageTrendPoint) => point[metric],
        color: 'var(--aviary-accent)',
      },
    ],
    [metric],
  );
  const summary = useMemo(
    () => summarizeSeries(points, (point) => point[metric]),
    [points, metric],
  );

  return (
    <figure className="m-0">
      <TimeSeriesChart
        data={points}
        x={day}
        series={series}
        formatValue={format}
        formatX={formatDayTick}
        integer={!cost}
        ariaLabel={`daily ${cost ? 'cost' : 'token'} trend`}
        height={height}
      />
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
