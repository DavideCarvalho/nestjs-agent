import { rmSync } from 'node:fs';
import { defineConfig } from 'tsup';

// The Nest entry imports this package by name, so it shares the main entry's classes at runtime
// (`RagScopeRequiredError` keeps working with `instanceof`) instead of bundling a second copy.
const entry = { index: 'src/index.ts', 'nestjs/index': 'src/nestjs/index.ts' };
const external = ['@dudousxd/nestjs-agent-rag', '@nestjs/common'];

// tsup builds the entries of a config array concurrently, so a per-entry `clean: true` races the
// other passes and can delete files they already wrote (e.g. `index.d.cts`, seen under a loaded
// `turbo run build`). Clean the output directory once, before any pass starts, and let no entry
// clean. `scripts/check-package-exports.mjs` (prepack) fails the pack if an entry is still missing.
rmSync('dist', { recursive: true, force: true });

export default defineConfig([
  {
    entry,
    format: ['esm'],
    dts: true,
    clean: false,
    splitting: false,
    sourcemap: true,
    outDir: 'dist',
    external,
  },
  {
    entry,
    format: ['cjs'],
    dts: true,
    clean: false,
    splitting: false,
    sourcemap: true,
    outDir: 'dist',
    external,
  },
]);
