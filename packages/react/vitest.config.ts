import { defineConfig } from 'vitest/config';
import { alias, plugins } from '../../vitest.shared.js';

export default defineConfig({
  plugins,
  resolve: { alias },
  test: {
    globals: true,
    environment: 'jsdom',
  },
});
