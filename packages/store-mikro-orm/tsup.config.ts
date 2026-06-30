import { defineConfig } from 'tsup';

const external = [
  '@dudousxd/nestjs-agent-core',
  '@mikro-orm/core',
  '@mikro-orm/nestjs',
  '@nestjs/common',
];

export default defineConfig([
  {
    entry: ['src/index.ts'],
    format: ['esm'],
    dts: true,
    clean: true,
    splitting: false,
    sourcemap: true,
    outDir: 'dist',
    external,
  },
  {
    entry: ['src/index.ts'],
    format: ['cjs'],
    dts: true,
    clean: false,
    splitting: false,
    sourcemap: true,
    outDir: 'dist',
    external,
  },
]);
