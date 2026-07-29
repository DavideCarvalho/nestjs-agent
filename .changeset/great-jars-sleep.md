---
'@dudousxd/nestjs-agent-dashboard': minor
---

Draw the governance console's charts with recharts, so they can be read rather than just looked at.

The spend trend, the run/failure trend and both share donuts were hand-rolled inline SVG. They had no
interactivity of any kind — no hover, no tooltip, no axes — so the only way to learn what a day cost
was to guess from the curve's height. The trends were also drawn into a fixed 720-wide `viewBox` with
`preserveAspectRatio="none"`, which stretched the geometry horizontally at every other container
width; stroke weights and dot radii distorted along with it.

All three are now recharts, inside a `ResponsiveContainer` that re-measures instead of scaling:

- Tooltips give the exact value and the day it belongs to. The run/failure tooltip also states that
  day's failure rate, which previously could only be eyeballed from the gap between two lines.
- Real x/y axes, tick labels, and a `<figcaption>` naming the range and the peak — an ops console is
  read far more often than it is hovered.
- Keyboard-navigable plots (recharts' accessibility layer, on by default in v3) and honest semantics:
  a `<figure>`/`<figcaption>` pair rather than a `role="img"` wrapper around interactive content.

Chart chrome (axis ticks, grid hairlines, hover cursor, tooltip surface) is themed once in
`src/app/chart-ui.tsx` against the console's existing CSS custom properties, so the charts read as
part of the console rather than as a library's defaults.

`recharts` is declared as a real dependency of this package, never as an undeclared import — and it is
reachable only from the SPA under `src/app/`, which is pre-built into `dist/spa`. The published
`./react` entry still resolves to four modules and pulls in no charting code, so a host that imports
`<OpenAgentConsoleButton />` does not get recharts in its bundle. The SPA build now emits recharts as
its own chunk (~408 kB raw / ~118 kB gzip) so console releases do not invalidate it in browser caches.

The pure SVG-geometry modules `trend-path.ts` and `run-trend-path.ts` are gone — recharts owns that
projection now — replaced by `trend-summary.ts` (range/peak/total for the captions) and `format-day.ts`
(calendar-day labels that never go through `Date`, so a `YYYY-MM-DD` never renders as the day before
in a negative-offset timezone). Both are unit-tested, as their predecessors were.
