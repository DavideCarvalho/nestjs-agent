import type { ReactNode } from 'react';
import { Card } from './ui/card';

/**
 * Shared chart chrome for the console's recharts surfaces.
 *
 * Recharts styles axes, grids and cursors through raw SVG props rather than class names, so the
 * console's CSS custom properties have to be threaded in explicitly. Doing that once here is what
 * keeps the charts from reading as a different design system pasted into the page — every chart
 * borrows the same hairlines, the same muted mono ticks, and the same panel surface for tooltips.
 */

/** Axis ticks: muted, mono, small — the same voice as the tabular numbers elsewhere in the console. */
export const AXIS_TICK = {
  fill: 'var(--muted)',
  fontSize: 10,
  fontFamily: '"JetBrains Mono", ui-monospace, monospace',
} as const;

/** Axis rule + tick marks. The console draws hairlines, never full-weight rules. */
export const AXIS_LINE = { stroke: 'var(--line)' } as const;

/** The vertical guide recharts draws under the pointer (and under keyboard focus). */
export const CURSOR = { stroke: 'var(--line)', strokeWidth: 1, strokeDasharray: '3 3' } as const;

/** Grid: horizontal hairlines only — vertical ones fight the page's blueprint background. */
export const GRID = { stroke: 'var(--line-soft)', vertical: false } as const;

/**
 * Tooltip surface. Reuses the `.panel` treatment so a tooltip looks like a small piece of the
 * console rather than a library default, and carries enough shadow to separate from the chart.
 */
export function TooltipCard({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Card className="px-2.5 py-2 text-[11px] shadow-lg shadow-black/50">
      <div className="mono mb-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        {title}
      </div>
      <div className="space-y-1">{children}</div>
    </Card>
  );
}

/** One series inside a {@link TooltipCard}: swatch, name, right-aligned value. */
export function TooltipRow({
  color,
  label,
  value,
}: {
  color: string;
  label: string;
  value: string;
}) {
  return (
    <div className="flex items-center gap-2">
      <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: color }} />
      <span className="min-w-0 truncate text-muted-foreground">{label}</span>
      <span className="mono tnum ml-auto shrink-0 pl-4 text-foreground">{value}</span>
    </div>
  );
}

/**
 * The line under a chart that states its range and peak. Recharts gives you hover; it does not give
 * you a chart that is legible without hovering, and an ops console is read far more often than it is
 * poked at. Rendered as a real `<figcaption>` so the summary is also what a screen reader gets.
 */
export function ChartCaption({ children }: { children: ReactNode }) {
  return (
    <figcaption className="mono mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
      {children}
    </figcaption>
  );
}
