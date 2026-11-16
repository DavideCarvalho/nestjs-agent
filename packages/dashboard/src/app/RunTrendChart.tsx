import { useMemo } from 'react';
import { TimeSeriesChart } from '../aviary-kit/charts/time-series-chart';
import type { RunTrendPoint } from '../client/agent-client';
import { formatDayLabel, formatDayTick } from '../client/format-day';
import { formatCount, formatPercent } from '../client/format-usd';
import { summarizeSeries } from '../client/trend-summary';
import { ChartCaption } from './chart-ui';

const day = (point: RunTrendPoint) => point.day;

/**
 * Both series on ONE y-axis, on purpose: the failure line has to read as a fraction of the run
 * line, and giving `failed` its own scale would make a handful of failures look like an outage.
 */
const SERIES = [
  {
    key: 'runs',
    label: 'runs',
    value: (point: RunTrendPoint) => point.runs,
    color: 'var(--aviary-accent)',
  },
  {
    key: 'failed',
    label: 'failed',
    value: (point: RunTrendPoint) => point.failed,
    color: 'var(--aviary-bad)',
  },
];

/** The failure rate under the two counts, which otherwise could only be eyeballed. */
const failureRate = (point: RunTrendPoint) => [
  { label: 'failure rate', value: formatPercent(point.runs > 0 ? point.failed / point.runs : 0) },
];

/**
 * Daily runs vs. failed runs as the console kit's time series (TanStack Charts). Hovering or
 * focusing a day shows both counts and the failure rate in the kit tooltip.
 */
export function RunTrendChart({
  points,
  height = 200,
}: {
  points: RunTrendPoint[];
  height?: number;
}) {
  const runs = useMemo(() => summarizeSeries(points, (point) => point.runs), [points]);
  const failed = useMemo(() => summarizeSeries(points, (point) => point.failed), [points]);

  return (
    <figure className="m-0">
      <TimeSeriesChart
        data={points}
        x={day}
        series={SERIES}
        formatValue={formatCount}
        formatX={formatDayTick}
        extraRows={failureRate}
        integer
        ariaLabel="daily runs vs failed runs"
        height={height}
      />
      <ChartCaption>
        <span className="flex items-center gap-3">
          <SeriesKey color="var(--aviary-accent)" label="runs" />
          <SeriesKey color="var(--aviary-bad)" label="failed" />
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
