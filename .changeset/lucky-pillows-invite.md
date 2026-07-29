---
'@dudousxd/nestjs-agent-dashboard': minor
---

Bring the governance console onto the shared Aviary look, and onto shadcn/Base UI primitives.

The console's neutrals had drifted from the other three consoles on every single value (`#08080b`
vs `#09090b`, `#e8e8ee` vs `#e7e7ea`, and four more nobody had chosen). They now match `AVIARY-UI.md`
byte for byte, with `--live` adopted for in-flight states; the violet `--accent` stays, because that
is the deliberate per-console signature.

While normalising them this turned up a bug nothing could see: Tailwind 3 cannot apply an opacity
modifier to an arbitrary `var()` colour, so `bg-[var(--accent)]/10` compiled to **no rule at all**.
Every tinted surface in the console — the active nav pill, the Approve/Reject buttons, the failure
panels' borders — was rendering untinted, and a missing background is indistinguishable from one
that was meant to be absent. The tokens are now declared as Tailwind colour functions that
`color-mix` the modifier in, so those tints exist for the first time.

The hand-rolled kit is rebuilt on vendored shadcn primitives (Button, Badge, Input, Card, Table,
Select, Tabs, Tooltip, Popover, Dialog) generated against those tokens, with Base UI underneath.
`Stat`, `BarMeter`, `StatusPill` and `Pagination` are kept but now sit on the same primitives. The
drill-down drawer is a Base UI Dialog rather than a native `<dialog>`, so an overlay that has to
paint over it can. Base UI, `class-variance-authority`, `clsx` and `tailwind-merge` are
devDependencies: this package ships a pre-bundled SPA and its published entries import none of them,
so a host installs nothing extra.
