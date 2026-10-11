---
"@dudousxd/nestjs-agent-core": minor
"@dudousxd/nestjs-agent": minor
"@dudousxd/nestjs-agent-react": minor
---

The sandbox kit works with any styling or component stack, without presets (same API as `@adonis-agora/agent` 0.75).

`genuiSandboxKit({ styles, components, wrapper })`:

- `styles` are your style entries (plain CSS, Sass/Less, PostCSS, CSS modules, Bootstrap through `.scss`, Tailwind v3/v4). They are compiled with Vite's CSS pipeline, and fonts and images are inlined as `data:` URIs.
  - Tailwind is detected. The frame runs Tailwind's browser runtime with your theme, variants and utilities.
  - Any other CSS reaches the model as its class vocabulary. `stylesDocs` adds your own notes.
- `components` are modules, globs, directories or packages exporting React components. In a JavaScript project the docs fall back to propTypes.
- `wrapper` wraps the model's App (MUI's ThemeProvider + CssBaseline, emotion, styled-components). Portals render inside the frame.
- With no options, the styles come from the Vite entrypoints and the components from `components/ui`.
- `AgentGenuiModule.forRoot({ sandbox: { kit: true } })` / `defineSandbox({ theme, kit })` pick up whatever the plugin built. The prompt describes only what exists. `GET /agent/config` → `genui.sandbox` gains `css`.

Other fixes:

- The frame's JSX transpiler now ships prebuilt as a string. A minifying consumer build no longer breaks kit sandboxes (`m is not defined`).
- Outside production, the newer of the dev descriptor and the build manifest wins.
- Theme variables are read from workspace packages linked into `node_modules`.

**Breaking:** `tailwind`, `tailwindCss`, `entry` and `include` (now `components`), `writeSandboxKitDocs({ css })` (now `styles`), and `defineSandbox({ tailwind })` are removed. Passing them throws a migration message. The descriptor is `version: 2`, with assets under `assets`.
