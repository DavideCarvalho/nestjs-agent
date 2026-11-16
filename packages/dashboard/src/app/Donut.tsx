import { DonutChart } from '../aviary-kit/charts/donut-chart';
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

const segmentKey = (segment: DonutSegment) => segment.modelId;
const segmentValue = (segment: DonutSegment) => segment.value;
const segmentColor = (_segment: DonutSegment, index: number) => colorAt(index);

/**
 * Share donut, on the console kit's DonutChart (TanStack Charts). Slices run clockwise from 12
 * o'clock in segment order, coloured like the legend list beside it (`colorAt` by position).
 * Hovering or focusing a slice shows its name, formatted value and share in the kit tooltip.
 *
 * Callers pass segments with zero-share rows already dropped, so the share the tooltip derives from
 * `value` agrees with the percentages the legend prints.
 */
export function Donut({
  segments,
  size = 168,
  thickness = 20,
  centerLabel,
  centerSub,
  label = 'spend by model',
  valueLabel = 'value',
  formatValue = String,
}: {
  segments: DonutSegment[];
  size?: number;
  thickness?: number;
  centerLabel?: string;
  centerSub?: string;
  /** Accessible label for the chart — describes what the segments break down. */
  label?: string;
  /** What a slice's value is, as the tooltip row label ("cost", "failed runs"). */
  valueLabel?: string;
  /** Formats a segment's raw value for the tooltip (spend is USD, failures are a plain count). */
  formatValue?: (value: number) => string;
}) {
  return (
    <DonutChart
      data={segments}
      label={segmentKey}
      rowKey={segmentKey}
      value={segmentValue}
      color={segmentColor}
      valueLabel={valueLabel}
      formatValue={formatValue}
      ariaLabel={label}
      size={size}
      thickness={thickness}
      className="shrink-0"
      {...(centerLabel !== undefined ? { centerLabel } : {})}
      {...(centerSub !== undefined ? { centerSub } : {})}
    />
  );
}
