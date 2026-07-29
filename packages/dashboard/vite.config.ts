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
      output: {
        // Recharts (with its d3 scales/shapes) is by far the heaviest thing in the bundle, and Base
        // UI is the second. Both get their own chunk so the console's own code — which changes every
        // release — does not invalidate ~600 kB of dependencies in every browser cache on every
        // deploy.
        //
        // Base UI is listed as the SUBPATHS this console imports rather than the package root: the
        // root barrel reaches every primitive in the library, so naming it here would pull the
        // accordion, the menubar and thirty others into the chunk that tree-shaking had correctly
        // left out. Add a line when a new primitive is vendored under `src/app/ui/`.
        manualChunks: {
          recharts: ['recharts'],
          'base-ui': [
            '@base-ui-components/react/dialog',
            '@base-ui-components/react/popover',
            '@base-ui-components/react/select',
            '@base-ui-components/react/tabs',
            '@base-ui-components/react/tooltip',
            '@base-ui-components/react/use-render',
          ],
        },
      },
    },
  },
});
