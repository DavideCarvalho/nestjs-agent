import { defineConfig } from 'tsup';

export default defineConfig([
  {
    entry: [
      'src/index.ts',
      'src/durable/index.ts',
      'src/sink-redis/index.ts',
      'src/guardrails/index.ts',
      'src/genui/index.ts',
      'src/a2ui/index.ts',
      'src/media/index.ts',
    ],
    format: ['esm'],
    dts: true,
    clean: true,
    splitting: false,
    sourcemap: true,
    outDir: 'dist',
  },
  {
    entry: [
      'src/index.ts',
      'src/durable/index.ts',
      'src/sink-redis/index.ts',
      'src/guardrails/index.ts',
      'src/genui/index.ts',
      'src/a2ui/index.ts',
      'src/media/index.ts',
    ],
    format: ['cjs'],
    dts: true,
    clean: false,
    splitting: false,
    sourcemap: true,
    outDir: 'dist',
  },
]);
