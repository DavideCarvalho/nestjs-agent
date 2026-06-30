import { defineConfig } from 'vitest/config';
import { alias, plugins, testBase } from './vitest.shared';

export default defineConfig({
  resolve: { alias },
  plugins,
  test: {
    ...testBase,
    include: ['packages/*/src/**/*.spec.ts'],
    // `*.db.spec.ts` boot real infra via testcontainers — run them only via `pnpm test:db`.
    exclude: ['**/node_modules/**', '**/dist/**', '**/*.db.spec.ts'],
  },
});
