import { defineConfig } from 'tsup';

// `guardrails` is its own entry so `@dudousxd/nestjs-agent-core/guardrails` can be imported by a
// process that never runs the agent loop (a gateway proxying raw provider traffic).
const entry = { index: 'src/index.ts', 'guardrails/index': 'src/guardrails/index.ts' };

export default defineConfig([
  {
    entry,
    format: ['esm'],
    dts: true,
    clean: true,
    splitting: false,
    sourcemap: true,
    outDir: 'dist',
  },
  {
    entry,
    format: ['cjs'],
    dts: true,
    clean: false,
    splitting: false,
    sourcemap: true,
    outDir: 'dist',
  },
]);
