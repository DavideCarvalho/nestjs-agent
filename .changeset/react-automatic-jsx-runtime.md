---
"@dudousxd/nestjs-agent-react": patch
---

Fix `ReferenceError: React is not defined` when mounting `AgentProvider`, `GenuiProvider`,
`GenerativeUI`, `MessageList` or the json-render provider in an app with no global `React`.

The build compiled JSX to `React.createElement(...)`, which only works in a module that binds
`React` itself. The provider, `MessageList` and the generative-UI entries added in 0.24 (`.`,
`/genui`, `/genui/json-render`) do not, so they reached for a global. The source was right
(`jsx: react-jsx`); the build was not: the package inherited `emitDecoratorMetadata` from the repo's
base tsconfig, which makes tsup compile through swc, and swc's JSX transform is the classic one
whatever tsconfig says. The package now turns decorators off (it has none) and pins esbuild to the
automatic runtime, so the output imports `jsx` from `react/jsx-runtime`.

If you worked around it with `globalThis.React ??= React`, that line can go.

So it cannot come back: CI (and the release script) now run `pnpm check:dist`, which fails on any
built file in the repo that references `React.` without binding it, and loads every published entry
of this package — ESM and CJS — in a process with no global `React`, rendering the providers and
components.
