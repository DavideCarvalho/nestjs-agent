---
'@dudousxd/nestjs-agent-dashboard': minor
---

**React tier for the console launcher: `useOpenAgentConsole` / `openAgentConsoleMutationOptions` / `<OpenAgentConsoleButton>`, from the new `@dudousxd/nestjs-agent-dashboard/react` subpath.**

`openAgentConsole` is headless on purpose, but every React host was then rewriting the same three
things around it: an in-flight flag, an error slot, and a button that disables itself. Three tiers
now, pick the one that fits:

```tsx
import { OpenAgentConsoleButton } from '@dudousxd/nestjs-agent-dashboard/react';

<OpenAgentConsoleButton headers={() => ({ Authorization: `Bearer ${token()}` })} />;
```

- **`<OpenAgentConsoleButton>`** — drop-in. Deliberately unstyled: a bare `<button>` that forwards
  `className`/`style`/every other button prop, so it inherits the host's design system rather than
  importing CSS that fights it. Disables itself and sets `aria-busy` while the mint is in flight.
  A refusal renders as `<p role="alert">` by default — a launcher that silently does nothing reads
  as broken rather than forbidden. `renderError` substitutes your own node; `renderError={null}`
  opts out for a host that surfaces errors its own way.
- **`useOpenAgentConsole(options?)`** → `{ open, isPending, error, reset }` — the state a launcher UI
  needs, your markup. `open()` never rejects; the refusal lands in `error` as `ConsoleSessionError`.
  It deliberately does **not** clear `isPending` on success: the navigation is already underway, and
  flipping back to idle flickers "ready to click again" on a page that is leaving.
- **`openAgentConsoleMutationOptions(options?)`** → `{ mutationKey, mutationFn }` — the shape
  `useMutation` takes, so a host already on TanStack Query wires the launcher into its own cache,
  devtools and error handling with no adapter. This package never imports `@tanstack/react-query`,
  so a host that doesn't use Query pays nothing.

`react`/`react-dom` are **optional** peer dependencies: a host that only mounts
`AgentDashboardModule` is not forced to install React. The `./react` entry also re-exports the
`./client` console-session primitives, so a React consumer needs one import path rather than two.

Additive only: nothing existing changes.
