import { defineConfig } from 'vitest/config';
import { alias, plugins, testBase } from './vitest.shared';

// Integration tests that boot real infra (Postgres/MySQL/Redis via testcontainers).
// Shares the base aliases + swc; runs ONLY *.db.spec.ts with generous container timeouts. The global
// setup starts one Postgres and one MySQL for the whole run; the store suites run every case on
// SQLite, Postgres and MySQL. No Docker → the real-database cases skip (fail under CI).
export default defineConfig({
  resolve: { alias },
  plugins,
  test: {
    ...testBase,
    include: ['packages/*/src/**/*.db.spec.ts'],
    exclude: ['**/node_modules/**', '**/dist/**'],
    globalSetup: ['./vitest.db.global-setup.ts'],
    testTimeout: 120_000,
    hookTimeout: 180_000,
  },
});
