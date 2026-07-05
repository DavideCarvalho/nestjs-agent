import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  // The SPA is served under /ai-gateway; the UI controller rewrites this base when mounted elsewhere.
  base: '/ai-gateway/',
  build: {
    outDir: 'dist/spa',
    emptyOutDir: true,
    rollupOptions: {
      // `index.html` is the production SPA entry; `preview.html` is an additive, standalone
      // mock-data entry used only for visual verification of the console with no backend. Both are
      // listed explicitly so `vite build` keeps emitting the SPA while also compiling the preview.
      input: {
        index: resolve(__dirname, 'index.html'),
        preview: resolve(__dirname, 'preview.html'),
      },
    },
  },
});
