import { defineConfig } from 'tsup';

// The Nest entry imports this package by name, so it shares the main entry's classes at runtime
// (`RagScopeRequiredError` keeps working with `instanceof`) instead of bundling a second copy.
const entry = { index: 'src/index.ts', 'nestjs/index': 'src/nestjs/index.ts' };
const external = ['@dudousxd/nestjs-agent-rag', '@nestjs/common'];

export default defineConfig([
  {
    entry,
    format: ['esm'],
    dts: true,
    clean: true,
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
