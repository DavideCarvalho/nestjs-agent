import { defineConfig } from 'vitest/config';
import { alias, plugins, testBase } from './vitest.shared';

// Integration tests that boot real infra (Redis/MySQL via testcontainers).
// Shares the base aliases + swc; runs ONLY *.db.spec.ts with generous container timeouts.
export default defineConfig({
  resolve: { alias },
  plugins,
  test: {
    ...testBase,
    include: ['packages/*/src/**/*.db.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
