import { defineConfig } from 'tsup';

const entry = ['src/index.ts', 'src/client/index.ts'];

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
  {
    // The `poppy-agent` CLI: ESM only, its shebang kept.
    entry: { 'client/bin/poppy-agent': 'src/client/bin/poppy-agent.ts' },
    format: ['esm'],
    dts: false,
    clean: false,
    splitting: false,
    sourcemap: true,
    outDir: 'dist',
  },
]);
