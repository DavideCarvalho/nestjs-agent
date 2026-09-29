import { defineConfig } from 'tsup';

const entry = ['src/index.ts', 'src/builtins.ts'];

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
