# React server rendering

Register your application's existing React components once. The browser-compatible mapping serves `GenuiProvider`; the server uses the same components, definitions, and authoritative validation. No default UI styles are imposed.

```tsx
import { createComponent } from '@dudousxd/nestjs-agent-core/genui'
import { DataTable } from '@dudousxd/nestjs-agent-core/genui/builtins'
import { createReactComponentRegistry } from '@dudousxd/nestjs-agent-react/genui'
import { OrdersTable } from './orders-table'

export const registry = createReactComponentRegistry()
  .register(DataTable, { react: OrdersTable })
export const table = createComponent(DataTable)
// Browser: <GenuiProvider registry={registry.components} catalog={registry.catalog}>
```

The server entry imports no chat hooks or AI SDK code. HTML needs React and ReactDOM, matching versions 18 or newer. Optional peers are installed only for the entries you use.

```ts
import { createReactServerRenderer } from '@dudousxd/nestjs-agent-react/genui/server'

const renderer = createReactServerRenderer({
  registry,
  stylesheet: { path: '/app/public/report.css' }, // or CSS text
  theme: 'light', // escaped data-theme attribute on the main element
})
const presentation = await table({
  columns: [{ key: 'order', label: 'Order' }],
  rows: [{ order: 'A-123' }],
})
const html = await renderer.html(presentation)
```

Stylesheets are trusted application input; user CSS and user-selected filesystem paths are inappropriate. React escapes text and attributes. Registered React components are trusted application code and must avoid unsafe HTML interpolation. Missing React renderers use the trusted text fallback. Schema/version errors and rendering failures reject; applications control retries or downgrade behavior.

## PNG and PDF

Supply a `CaptureAdapter` (`images(htmlPages, options)` returns `Uint8Array[]`; `pdf(htmlPages, options)` returns one `Uint8Array`) or use the optional Playwright adapter. Install `playwright-core` only for the latter. Supply an existing Playwright browser, or `launchOptions.executablePath` pointing to your installed Chromium. No browser downloads occur implicitly.

```ts
import { createPlaywrightCaptureAdapter } from '@dudousxd/nestjs-agent-react/genui/server/playwright'

const capture = createPlaywrightCaptureAdapter({ browser })
const images = await renderer.images(presentation, {
  capture, rowsPerPage: 25, width: 1200, height: 1600,
})
const pdf = await renderer.pdf(presentation, { capture, rowsPerPage: 25 })
```

`images` returns one PNG per logical page; `pdf` combines the logical pages. DataTable pagination slices rows before React rendering, preserves every record, and retains columns and other props on each page. Custom components can register `paginate(props, rowsPerPage)` returning complete page props; each custom page is revalidated. Hooks should return schema-compatible props and preserve all user records.

Dimensions are bounded: width 320–4096 pixels, height 200–16384 pixels, rowsPerPage 1–500, timeoutMs 100–60000, and 1–100 logical pages. Defaults are 1200×1600, 30 rows, and 15000 ms. Content taller than the chosen height rejects rather than silently clipping; reduce rowsPerPage, increase height, or paginate custom content. Font and image readiness is awaited. Capture runs in isolated contexts with page scripts and service workers disabled. Network requests abort by default; explicitly permit trusted fonts/images/styles via `allowAsset(url)` when needed. Pages and contexts close on success or failure. Caller-supplied browsers remain open; browsers launched by the adapter close after capture.

Binary pages are attachment data, never component-frame data. Persist the presentation and send resulting attachments through your transport only when your application authorizes it.

Local browser integration test:

```sh
GENUI_CHROMIUM_PATH=/path/to/chromium pnpm vitest run packages/react/src/genui/playwright.browser.spec.tsx
```
