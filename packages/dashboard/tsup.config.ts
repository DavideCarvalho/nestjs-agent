// The dashboard SERVER is a decorator-bearing NestJS module (@Module/@Injectable/@Inject/
// controllers), so its build MUST preserve `design:paramtypes` for DI — and it MUST emit dual
// ESM + CJS.
//
// Decorator metadata: `tsconfig.server.json` sets `emitDecoratorMetadata: true`, so tsup routes the
// TS->JS transform through `@swc/core` (a dev dep) which emits `Reflect.metadata('design:paramtypes',
// ...)`. Plain esbuild would drop that metadata and NestJS DI params would collapse to `Object`. This
// mirrors how the sibling `@dudousxd/nestjs-agent` package builds its NestJS decorators.
//
// Why dual ESM + CJS matters: a CJS host (a NestJS app built with `nest build` -> CommonJS) that
// `require`s this package while also `require`ing `@dudousxd/nestjs-agent` must resolve the dashboard
// (and, transitively, `@dudousxd/nestjs-agent-core`) in the SAME module system as the rest of the
// agent packages. The DI tokens survive an ESM/CJS split (they are `Symbol.for`), but shipping CJS
// keeps a CJS host from loading a second, ESM-only copy of the graph.
//
// `import.meta.url` (agent-ui.controller locates the SPA via `new URL('../spa', import.meta.url)`) is
// shimmed in the CJS output so asset resolution works when `require`d. The Vite SPA build (dist/spa)
// and the client types build (dist/client) are driven separately by the package's `build` script.
import { defineConfig } from 'tsup';

const common = {
  entry: ['src/server/index.ts'],
  outDir: 'dist/server',
  splitting: false,
  sourcemap: true,
  external: [
    '@dudousxd/nestjs-agent-core',
    '@dudousxd/nestjs-diagnostics',
    '@nestjs/common',
    '@nestjs/core',
    'rxjs',
    'reflect-metadata',
  ],
  // Point the DTS build at a tsconfig with real `compilerOptions` (decorators + NodeNext); the
  // solution-style root `tsconfig.json` (only `references`) would leave the DTS build without
  // `experimentalDecorators`/module resolution and it would fail.
  tsconfig: 'tsconfig.server.json',
} as const;

export default defineConfig([
  { ...common, format: ['esm'], dts: true, clean: true },
  {
    ...common,
    format: ['cjs'],
    dts: true,
    clean: false,
    // Define `import.meta.url` from `__filename` so the SPA-locating `new URL('../spa', ...)` resolves
    // under CJS `require`.
    banner: { js: "const __importMetaUrl = require('url').pathToFileURL(__filename).href;" },
    esbuildOptions(options) {
      options.define = { ...options.define, 'import.meta.url': '__importMetaUrl' };
    },
  },
]);
