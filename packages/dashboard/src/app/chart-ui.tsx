import type { ReactNode } from 'react';

/**
 * The line under a chart that states its range and peak. A tooltip gives you a number on hover; it
 * does not give you a chart that is legible without hovering, and an ops console is read far more
 * often than it is poked at. Rendered as a real `<figcaption>` so the summary is also what a screen
 * reader gets.
 */
export function ChartCaption({ children }: { children: ReactNode }) {
  return (
    <figcaption className="mono mt-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-1 text-[10px] text-muted-foreground">
      {children}
    </figcaption>
  );
}
