import { defineConfig } from 'vitest/config';
import { alias, plugins, testBase } from './vitest.shared';

export default defineConfig({
  resolve: { alias },
  plugins,
  test: {
    ...testBase,
    // `.tsx` too: the dashboard's React tier (`packages/dashboard/src/react`) ships published
    // components, and a `.ts`-only glob silently collected none of their specs.
    include: ['packages/*/src/**/*.spec.{ts,tsx}'],
    // `*.db.spec.ts` boot real infra via testcontainers — run them only via `pnpm test:db`.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.db.spec.ts'],
  },
});
