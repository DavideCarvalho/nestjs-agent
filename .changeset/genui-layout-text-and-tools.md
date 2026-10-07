---
"@dudousxd/nestjs-agent-core": patch
"@dudousxd/nestjs-agent": patch
---

genui: layout components behave as layout outside a tree.

- `componentToText` / `treeToText`: a layout component (`children: true`, e.g. `Stack`, or a `Card` without a title) whose `fallbackText` comes out empty now writes nothing, instead of printing its props (`{ "direction": "row" }`) as a JSON block. Content components with an empty text still fall back to JSON.
- `genuiTools` no longer makes a `ui__show_<name>` tool for a layout component, and the generic show tool (`ui__show`) neither offers nor accepts one: a flat props input cannot carry children, so those tools could only push an empty box. Tree mode (`ui__render`) is unchanged. New helper: `flatComponents(catalog)`.
- `Chart` text fallback: every series is drawn (one bar per series per point, on a shared scale), and `type: 'line'` renders as a table of the x values and each series instead of bars of the first series only.
