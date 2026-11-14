import { resolve } from 'node:path';
import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react(), tailwindcss()],
  // The SPA is served under /ai-gateway; the UI controller rewrites this base when mounted elsewhere.
  base: '/ai-gateway/',
  // CSS-referenced assets (the kit's bundled fonts) load relative to the stylesheet: the controller
  // rewrites the `/ai-gateway/` base in index.html only, so an absolute `/ai-gateway/assets/…` font
  // URL inside the CSS would 404 once the console is mounted anywhere else.
  experimental: {
    renderBuiltUrl: (_file, { hostType }) => (hostType === 'css' ? { relative: true } : undefined),
  },
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
        // left out. Add a line when a new primitive is vendored under `src/app/ui/` or `src/aviary-kit/ui/`.
        manualChunks: {
          recharts: ['recharts'],
          'base-ui': [
            '@base-ui/react/avatar',
            '@base-ui/react/button',
            '@base-ui/react/collapsible',
            '@base-ui/react/dialog',
            '@base-ui/react/drawer',
            '@base-ui/react/input',
            '@base-ui/react/menu',
            '@base-ui/react/merge-props',
            '@base-ui/react/popover',
            '@base-ui/react/scroll-area',
            '@base-ui/react/select',
            '@base-ui/react/tabs',
            '@base-ui/react/separator',
            '@base-ui/react/tooltip',
            '@base-ui/react/use-render',
          ],
        },
      },
    },
  },
});
