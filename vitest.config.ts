import { defineConfig } from 'vitest/config';
import { alias, plugins, testBase } from './vitest.shared';

export default defineConfig({
  resolve: { alias },
  plugins,
  test: {
    ...testBase,
    // `.tsx` too: the dashboard's React tier (`packages/dashboard/src/react`) ships published
    // components, and a `.ts`-only glob silently collected none of their specs.
    // `registry/` too: its components are copy-in source rather than a package export, so they
    // live outside packages/ — and are still specced here, against the same model.
    include: ['packages/*/src/**/*.spec.{ts,tsx}', 'registry/src/**/*.spec.{ts,tsx}'],
    // `*.db.spec.ts` boot real infra via testcontainers — run them only via `pnpm test:db`.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.db.spec.ts'],
  },
});
